import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import sharp from 'sharp';
import nodemailer from 'nodemailer';
import Database from 'better-sqlite3';
import { rateLimit } from 'express-rate-limit';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const rawPort = process.env.PORT;
const port = rawPort ? (isNaN(Number(rawPort)) ? rawPort : Number(rawPort)) : 3000;
const dbPath = path.resolve(root, process.env.DB_PATH || './data/enpee.sqlite');
const uploadDir = path.resolve(root, process.env.UPLOAD_DIR || './uploads');
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    console.warn('⚠️ WARNING: SESSION_SECRET is not set in production. Generating secure temporary 256-bit key.');
    sessionSecret = crypto.randomBytes(32).toString('hex');
  } else {
    sessionSecret = process.env.SESSION_SECRET || 'enpee_dev_session_secret_key_2026_min_32_characters';
  }
}

if (process.env.PUBLIC_ORIGIN) {
  try {
    const publicOrigin = new URL(process.env.PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(publicOrigin.protocol)) console.warn('PUBLIC_ORIGIN should use HTTP or HTTPS.');
  } catch (err) {
    console.warn('⚠️ Warning: Invalid PUBLIC_ORIGIN, ignoring:', err.message);
  }
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS site_documents (
    key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS content_items (
    id TEXT PRIMARY KEY, collection TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS content_collection_idx ON content_items(collection);
  CREATE TABLE IF NOT EXISTS enquiries (
    id TEXT PRIMARY KEY, parent_name TEXT NOT NULL, student_name TEXT NOT NULL,
    mobile TEXT NOT NULL, email TEXT NOT NULL, applying_class TEXT NOT NULL,
    academic_year TEXT NOT NULL, previous_school TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'Admission',
    status TEXT NOT NULL DEFAULT 'New', internal_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY, filename TEXT NOT NULL, original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL, size INTEGER NOT NULL, category TEXT NOT NULL DEFAULT 'General',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY, admin_email TEXT NOT NULL, action TEXT NOT NULL,
    target TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL
  );

  /* Section-First Dynamic CMS Tables */
  CREATE TABLE IF NOT EXISTS cms_sections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Core',
    display_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'published',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cms_content_blocks (
    id TEXT PRIMARY KEY,
    section_id TEXT NOT NULL REFERENCES cms_sections(id) ON DELETE CASCADE,
    block_key TEXT NOT NULL,
    label TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'rich_text',
    draft_value TEXT NOT NULL DEFAULT '',
    published_value TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'published',
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cms_image_requirements (
    id TEXT PRIMARY KEY,
    section_id TEXT NOT NULL REFERENCES cms_sections(id) ON DELETE CASCADE,
    slot_key TEXT NOT NULL,
    label TEXT NOT NULL,
    min_width INTEGER DEFAULT 0,
    max_width INTEGER DEFAULT 10000,
    min_height INTEGER DEFAULT 0,
    max_height INTEGER DEFAULT 10000,
    exact_width INTEGER,
    exact_height INTEGER,
    aspect_ratio TEXT,
    aspect_ratio_tolerance REAL DEFAULT 0.05,
    allowed_formats TEXT NOT NULL DEFAULT 'jpg,jpeg,png,webp,avif',
    max_size_kb INTEGER NOT NULL DEFAULT 5120,
    required INTEGER NOT NULL DEFAULT 0,
    allow_multiple INTEGER NOT NULL DEFAULT 0,
    help_text TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cms_section_images (
    id TEXT PRIMARY KEY,
    section_id TEXT NOT NULL REFERENCES cms_sections(id) ON DELETE CASCADE,
    slot_key TEXT NOT NULL,
    media_url TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT NOT NULL DEFAULT 'image/webp',
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    dpi INTEGER,
    alt_text TEXT DEFAULT '',
    caption TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'published',
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cms_marquees (
    id TEXT PRIMARY KEY,
    section_id TEXT NOT NULL REFERENCES cms_sections(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    link_url TEXT DEFAULT '',
    direction TEXT NOT NULL DEFAULT 'ltr',
    speed_seconds INTEGER NOT NULL DEFAULT 20,
    bg_color TEXT NOT NULL DEFAULT '#1E61AC',
    text_color TEXT NOT NULL DEFAULT '#FFFFFF',
    font_size_px INTEGER NOT NULL DEFAULT 14,
    font_weight TEXT NOT NULL DEFAULT '600',
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    start_date TEXT,
    expiry_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cms_content_revisions (
    id TEXT PRIMARY KEY,
    section_id TEXT NOT NULL REFERENCES cms_sections(id) ON DELETE CASCADE,
    admin_email TEXT NOT NULL,
    change_type TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
if (!db.pragma('table_info(enquiries)').some((column) => column.name === 'previous_school')) {
  db.exec("ALTER TABLE enquiries ADD COLUMN previous_school TEXT NOT NULL DEFAULT ''");
}




const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const slugify = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const contentSlug = (title, recordId) => `${slugify(title)}-${String(recordId).slice(0, 8)}`;

import { all14Sections } from './sections_data.mjs';

function seedCmsSections() {
  const sectionCount = db.prepare('SELECT COUNT(*) AS count FROM cms_sections').get().count;
  if (sectionCount >= 14) return;

  const nowTime = now();
  const tx = db.transaction(() => {
    for (const sec of all14Sections) {
      db.prepare(`INSERT OR REPLACE INTO cms_sections(id, name, description, category, display_order, status, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, 'published', ?, ?)`).run(sec.id, sec.name, sec.description, sec.category, sec.display_order, nowTime, nowTime);

      if (Array.isArray(sec.blocks)) {
        for (let i = 0; i < sec.blocks.length; i++) {
          const b = sec.blocks[i];
          const existing = db.prepare('SELECT id FROM cms_content_blocks WHERE section_id = ? AND block_key = ?').get(sec.id, b.key);
          if (!existing) {
            db.prepare(`INSERT INTO cms_content_blocks(id, section_id, block_key, label, content_type, draft_value, published_value, status, display_order, created_at, updated_at)
              VALUES(?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`).run(id(), sec.id, b.key, b.label, b.type, b.val, b.val, (i + 1) * 10, nowTime, nowTime);
          }
        }
      }

      if (Array.isArray(sec.requirements)) {
        for (const r of sec.requirements) {
          const existing = db.prepare('SELECT id FROM cms_image_requirements WHERE section_id = ? AND slot_key = ?').get(sec.id, r.slot);
          if (!existing) {
            db.prepare(`INSERT INTO cms_image_requirements(id, section_id, slot_key, label, min_width, max_width, min_height, max_height, exact_width, exact_height, aspect_ratio, aspect_ratio_tolerance, allowed_formats, max_size_kb, required, allow_multiple, help_text, created_at, updated_at)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
              id(), sec.id, r.slot, r.label, r.min_w || 0, r.max_w || 10000, r.min_h || 0, r.max_h || 10000,
              r.exact_w || null, r.exact_h || null, r.aspect_ratio || null, r.aspect_ratio_tolerance || 0.05,
              r.allowed_formats || 'jpg,jpeg,png,webp,avif', r.max_kb || 5120, r.required ? 1 : 0, r.allow_multiple ? 1 : 0,
              r.help || '', nowTime, nowTime
            );
          }
        }
      }

      if (Array.isArray(sec.images)) {
        for (let j = 0; j < sec.images.length; j++) {
          const img = sec.images[j];
          const existing = db.prepare('SELECT id FROM cms_section_images WHERE section_id = ? AND slot_key = ?').get(sec.id, img.slot);
          if (!existing) {
            db.prepare(`INSERT INTO cms_section_images(id, section_id, slot_key, media_url, original_name, file_size, mime_type, width, height, status, display_order, created_at, updated_at)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`).run(
              id(), sec.id, img.slot, img.url, img.name, 102400, 'image/jpeg', img.w || 1200, img.h || 800, (j + 1) * 10, nowTime, nowTime
            );
          }
        }
      }

      if (Array.isArray(sec.marquees)) {
        for (let k = 0; k < sec.marquees.length; k++) {
          const m = sec.marquees[k];
          const existing = db.prepare('SELECT id FROM cms_marquees WHERE section_id = ? AND text = ?').get(sec.id, m.text);
          if (!existing) {
            db.prepare(`INSERT INTO cms_marquees(id, section_id, text, link_url, direction, speed_seconds, bg_color, text_color, font_size_px, font_weight, display_order, is_active, created_at, updated_at)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
              id(), sec.id, m.text, m.link || '', m.dir || 'ltr', m.speed || 20, m.bg || '#1E61AC', m.text_col || '#FFFFFF', 14, '600', (k + 1) * 10, nowTime, nowTime
            );
          }
        }
      }
    }
  });

  tx();
  console.log('Seeded / synced 14 CMS Sections successfully.');
}
seedCmsSections();
const defaults = {
  navigation: {
    items: [
      { id: 'home', label: 'Home', href: '/', parentId: '', displayOrder: 10, visible: true, prominent: false, newTab: false },
      { id: 'about-us', label: 'About Us', href: '/about', parentId: '', displayOrder: 20, visible: true, prominent: false, newTab: false },
      { id: 'about-school', label: 'About the School', href: '/about', parentId: 'about-us', displayOrder: 10, visible: true, prominent: false, newTab: false },
      { id: 'promoters', label: 'Promoters', href: '/promoters', parentId: 'about-us', displayOrder: 20, visible: true, prominent: false, newTab: false },
      { id: 'management', label: 'Management', href: '/management', parentId: 'about-us', displayOrder: 30, visible: true, prominent: false, newTab: false },
      { id: 'advisory-board', label: 'Advisory Board', href: '/management#advisory-board', parentId: 'about-us', displayOrder: 40, visible: true, prominent: false, newTab: false },
      { id: 'cbse-disclosure', label: 'CBSE Mandatory Disclosure', href: 'https://www.enpeekkl.com/cbse-mandatory-disclosure.php', parentId: 'about-us', displayOrder: 50, visible: true, prominent: false, newTab: true },
      { id: 'campus-culture', label: 'Campus & Culture', href: '#campus', parentId: '', displayOrder: 30, visible: true, prominent: false, newTab: false },
      { id: 'chateau-francais', label: 'Château Français', href: '/chateau-francais', parentId: 'campus-culture', displayOrder: 10, visible: true, prominent: false, newTab: false },
      { id: 'what-makes-us-different', label: 'What Makes Us Different', href: '/what-makes-us-different', parentId: 'campus-culture', displayOrder: 20, visible: true, prominent: false, newTab: false },
      { id: 'academics', label: 'Academics', href: '#academics', parentId: '', displayOrder: 40, visible: true, prominent: false, newTab: false },
      { id: 'the-way-we-work', label: 'The Way We Work', href: '/way-we-work', parentId: 'academics', displayOrder: 10, visible: true, prominent: false, newTab: false },
      { id: 'programs-offered', label: 'Programs Offered', href: '/programs-offered', parentId: 'academics', displayOrder: 20, visible: true, prominent: false, newTab: false },
      { id: 'contact-us', label: 'Contact Us', href: '/contact-us', parentId: '', displayOrder: 50, visible: true, prominent: false, newTab: false },
      { id: 'admissions', label: 'Admissions Enquiry', href: '/contact-us#admissions', parentId: '', displayOrder: 60, visible: true, prominent: true, newTab: false }
    ]
  },
  sections: {
    navHome: 'Home',
    navAbout: 'About Us',
    navAcademics: 'Academics',
    navCampus: 'Campus & Facilities',
    navActivities: 'Activities',
    navSports: 'Sports Academy',
    navGallery: 'Gallery',
    navContact: 'Contact Us',
    navPromoters: 'Promoters',
    navManagement: 'Management',
    navChateau: 'Château Français',
    navWayWeWork: 'The Way We Work',
    navPrograms: 'Programs Offered',
    navDifferent: 'What Makes Us Different',
    videosHeading: 'Experience ENPEE International School',
    videosSubtitle: 'Discover our campus, learning environment and student experiences.',
    topAdmissionsText: 'Admissions Open – Academic Year',
    headerAdmissionsText: 'Admissions Enquiry',
    heroTagline: 'CBSE SCHOOL | KARAIKAL',
    heroEyebrow: 'Karaikal’s 1st Premium School · CBSE Aff. No. 2930085',
    heroAdmissionLabel: 'Admissions Open',
    aboutEyebrow: 'About Us',
    aboutFactOneTitle: '5 Acres',
    aboutFactOneDetail: 'Green, secure campus',
    aboutFactTwoTitle: 'CBSE',
    aboutFactTwoDetail: 'Aff. No. 2930085',
    aboutFactThreeTitle: 'French-style',
    aboutFactThreeDetail: 'Château Français',
    aboutFactFourTitle: 'Digitized',
    aboutFactFourDetail: 'Interactive classrooms',
    aboutLinkText: 'Read the school’s story →',
    aboutLinkUrl: 'https://www.enpeekkl.com/about.php',
    campusEyebrow: 'Campus & Facilities',
    campusHeading: 'An Inspiring Environment for Every Learner',
    campusDescription: 'Our 5-acre campus is surrounded by greenery, with French-style architecture and a secure environment for learning.',
    campusLinkText: 'Explore School Gallery →',
    campusLinkUrl: '#gallery',
    academicsEyebrow: 'Academics',
    academicsHeading: 'Programs for {academicYear}',
    academicsDescription: 'Admissions are open for Pre-KG to Class IX under the CBSE curriculum, following NCERT books.',
    languageOptions: ['Tamil', 'French', 'Arabic', 'Hindi'],
    featuresEyebrow: 'Why ENPEE',
    featuresHeading: 'Why Choose ENPEE?',
    activitiesEyebrow: 'Activities',
    activitiesHeading: 'Learning Beyond the Classroom',
    sportsHeading: 'ENPEE Sports Academy',
    sportsDescription: 'Facilities include a track and field, skating rink, archery, basketball, badminton, table tennis and football.',
    eventsEyebrow: 'School calendar',
    eventsHeading: 'Events & Celebrations',
    partnersEyebrow: 'Our community',
    partnersHeading: 'School Partners & Providers',
    leadershipEyebrow: 'Leadership',
    leadershipHeading: 'Promoters & School Management',
    parentResourcesEyebrow: 'Parents’ Corner',
    parentResourcesHeading: 'Resources for Families',
    parentEnquiryHeading: 'Send a parent enquiry',
    parentEnquiryNameLabel: 'Your name',
    parentEnquiryEmailLabel: 'Email address',
    parentEnquiryMessageLabel: 'How can we help?',
    parentEnquirySubmitText: 'Send Parent Enquiry',
    galleryEyebrow: 'Campus life',
    galleryHeading: 'Moments at ENPEE',
    galleryDescription: 'Explore learning, activities and school life across our campus.',
    galleryFilters: ['All photos', 'Campus', 'Learning', 'Sports', 'Events'],
    galleryExploreText: 'View More School Photos →',
    galleryExploreUrl: 'https://www.instagram.com/enpeeschool/',
    philosophyEyebrow: 'Our Educational Philosophy',
    philosophyHeading: 'KNOWLEDGE | INNOVATION | EXCELLENCE',
    philosophyDescription: 'The core values that guide every classroom, every activity and every child at ENPEE.',
    admissionsEyebrow: 'Admissions',
    admissionsHeading: 'Give Your Child a Remarkable Beginning',
    admissionsDescription: 'Admissions are open. Join the ENPEE learning community.',
    admissionClasses: ['Pre-KG', 'LKG – UKG', 'Classes I – IX'],
    gradeOptions: ['Pre-KG', 'LKG', 'UKG', 'Class I', 'Class II', 'Class III', 'Class IV', 'Class V', 'Class VI', 'Class VII', 'Class VIII', 'Class IX'],
    admissionsButtonText: 'WhatsApp Enquiry',
    admissionFormHeading: 'Admission Enquiry',
    admissionParentLabel: 'Parent / Guardian name',
    admissionStudentLabel: 'Student name',
    admissionEmailLabel: 'Email address',
    admissionMobileLabel: 'Mobile number',
    admissionClassLabel: 'Applying for Grade',
    admissionYearLabel: 'Academic Year',
    admissionPreviousSchoolLabel: 'Previous School (optional)',
    admissionMessageLabel: 'Message / Additional Information (optional)',
    admissionSubmitText: 'Submit Enquiry',
    parentsCornerHeading: 'Parents’ Corner.',
    parentsCornerIntro: 'We would love to meet you and your child and walk you around the campus.',
    downloadsText: 'Downloads & documents',
    downloadsUrl: 'https://www.enpeekkl.com/downloads.php',
    disclosureText: 'CBSE Mandatory Disclosure',
    disclosureUrl: 'https://www.enpeekkl.com/cbse-mandatory-disclosure.php',
    testimonialsHeading: 'Testimonials',
    testimonialsMessage: 'Parent testimonials will be shared here once they are approved for publication.',
    announcementsHeading: 'Announcements & News',
    announcementsLinkText: 'View school news & events',
    announcementsLinkUrl: 'https://www.enpeekkl.com/news-events.php',
    contactEyebrow: 'Contact',
    contactHeading: 'Visit ENPEE',
    directionsText: 'Get Directions',
    callText: 'Call Now',
    contactWhatsappText: 'WhatsApp',
    emailText: 'Email Us',
    contactFormHeading: 'Send us a message',
    contactFormNameLabel: 'Your name',
    contactFormEmailLabel: 'Email',
    contactFormMessageLabel: 'Message',
    contactFormSubmitText: 'Send Message',
    contactPhoneLabel: 'Phone',
    contactMobileLabel: 'Mobile',
    contactEmailLabel: 'Email',
    officeHoursLabel: 'Office hours',
    footerDescription: 'Karaikal’s 1st premium school. CBSE method of education. Refer to the latest CBSE Mandatory Disclosure for current affiliation details.',
    footerQuickLinksHeading: 'Quick Links',
    footerAboutLinkText: 'About Us',
    footerAcademicsLinkText: 'Programs Offered',
    footerPromotersLinkText: 'Promoters',
    footerManagementLinkText: 'Management',
    footerCampusLinkText: 'Château Français',
    footerActivitiesLinkText: 'The Way We Work',
    footerGalleryLinkText: 'What Makes Us Different',
    footerContactLinkText: 'Contact Us',
    footerAcademicsHeading: 'Academics & Admissions',
    footerProgramsLinkText: 'Programs Offered',
    footerEnquireLinkText: 'Enquire Now',
    footerFlyerLinkText: 'Admission Flyer (PDF)',
    footerDisclosureLinkText: 'CBSE Mandatory Disclosure',
    footerContactHeading: 'Contact'
  },
  home: {
    heroHeading: 'Where Young Minds Grow Into Extraordinary Futures.',
    heroDescription: 'Discover a world of knowledge, innovation and excellence at ENPEE International School, Karaikal.',
    heroImage: 'https://www.enpeekkl.com/images/banner/home-banner-01.jpg',
    logoImage: '',
    marqueeEnabled: true,
    academicYear: '2026–27',
    heroPrimaryText: 'Explore Our School',
    heroPrimaryLink: '#about',
    heroSecondaryText: 'Admissions Open – Enquire Now',
    heroSecondaryLink: '#admissions',
    statistics: [
      { title: 'CBSE Curriculum', detail: 'NCERT-based holistic learning' },
      { title: 'Smart Classrooms', detail: 'Interactive digitized learning' },
      { title: '5-Acre Campus', detail: 'Lush green, eco-friendly & secure environment' },
      { title: 'Sports Academy', detail: 'Professional coaching & performance assessment' }
    ],
    welcomeHeading: 'Welcome to ENPEE International School',
    welcomeText: 'A learning environment built on academic excellence, creativity, character development and holistic growth – guided by our core values of Knowledge, Innovation and Excellence.',
    highlights: ['CBSE Curriculum', 'Interactive Learning', 'Experienced Educators', 'Project-Based Learning', 'Holistic Development']
  },
  about: {
    introduction: 'A learning environment built on academic excellence, creativity, character development and holistic growth – guided by our core values of Knowledge, Innovation and Excellence.',
    vision: '',
    mission: '',
    values: ['Knowledge', 'Innovation', 'Excellence'],
    achievements: ['CBSE Affiliation No. 2930085', 'A 5-acre green campus', 'Admissions from Pre-KG to Class IX'],
    history: '',
    philosophy: '',
    learningEnvironment: '',
    infrastructure: '',
    chateauDescription: '',
    chateauImage: '',
    chateauPublished: false,
    wayWeWork: '',
    wayWeWorkPublished: false,
    parentsCornerMessage: '',
    parentsCornerImage: '',
    parentsCornerPublished: false,
    photos: [
      '/assets/images/school-img.jpg',
      '/assets/images/interactive-digitized.jpg'
    ]
  },
  contact: {
    schoolName: 'ENPEE International School',
    address: 'Château Français, ENPEE Enclave, 241/2, Puthakudy Village, Vadamattam Main Road, Nedungadu Panchayat, Karaikal – 609609, Puducherry.',
    phone: '04368 265 265',
    mobile: '+91 8300 111 265',
    email: 'info@enpeekkl.com',
    whatsapp: '+918300111265',
    mapsUrl: 'https://www.google.com/maps/search/?api=1&query=ENPEE+International+School+Karaikal',
    officeHours: 'Monday to Saturday, 9:00 AM – 4:00 PM',
    facebook: 'https://www.facebook.com/ENPEEInternationalSchool',
    instagram: 'https://www.instagram.com/enpeeschool/',
    youtube: 'https://www.youtube.com/@enpeeinternationalschoolka3067',
    linkedin: 'https://www.linkedin.com/in/enpee-international-school/',
    x: 'https://twitter.com/SchoolEnpee'
  },
  pages: {
    about: {
      title: 'About ENPEE International School',
      description: 'Learn about ENPEE International School, its beginnings, educational approach and core values in Karaikal.',
      image: 'https://www.enpeekkl.com/images/about-sub.jpg',
      published: true,
      sections: [
        { heading: 'Our beginnings', body: 'ENPEE International School began its academic journey in 2019 on a green campus in Karaikal. The school describes its approach as focused on academic learning, creativity, character and the development of the whole child.', bullets: [], image: '', published: true },
        { heading: 'Our vision', body: 'The school aims to offer quality education informed by international standards and to help young learners grow through new learning experiences.', bullets: [], image: '', published: true },
        { heading: 'Our mission', body: 'ENPEE’s stated mission includes developing skilled educators, providing a safe and child-friendly environment, and creating modern learning facilities for the community.', bullets: [], image: '', published: true },
        { heading: 'Our motto and core values', body: 'Knowledge, Innovation and Excellence guide the school’s educational philosophy.', bullets: ['Knowledge', 'Innovation', 'Excellence'], image: '', published: true },
        { heading: 'CBSE method of education', body: 'The school describes its teaching approach as following the CBSE method and using NCERT learning materials. Refer to the latest CBSE Mandatory Disclosure for current affiliation details.', bullets: [], image: '', published: true },
        { heading: 'Six areas of focus', body: 'The school highlights these strengths in its official materials.', bullets: ['Team building', 'Interactive learning', 'Project-based curriculum', 'Skilled educators', 'Holistic development', 'World-class facilities'], image: '', published: true }
      ]
    },
    promoters: {
      title: 'Promoters',
      description: 'Explore the institutional background of ENPEE International School and its promoters.',
      image: 'https://www.enpeekkl.com/images/national-pharma.jpg',
      published: true,
      sections: [
        { heading: 'National Pharma Group', body: 'The school’s official profile traces National Pharma to a pharmaceutical manufacturing unit established in Thanjavur in 1967. It describes the group’s growth from an early formulation to a broader range of products and regional reach.', bullets: [], image: '', published: true },
        { heading: 'Healthcare and community service', body: 'The National Pharma Hospital and Research Institute was established in Thanjavur in 2010, with medical services beginning in 2011. The school’s profile describes the hospital as part of the group’s wider healthcare work.', bullets: [], image: 'https://www.enpeekkl.com/images/national-pharma.jpg', published: true },
        { heading: 'Founder and recognition', body: 'The official school website identifies Rtn. PHF. Hajee L. Kamal Batcha as Founder and Chairman. It lists recognitions including Jamnalal Bajaj Merit Certificates and CHEMEXCIL export awards.', bullets: ['Jamnalal Bajaj Merit Certificate', 'International Asia Award, Singapore', 'CHEMEXCIL Export Promotion Award / Merit Certificate'], image: 'https://www.enpeekkl.com/images/chairman.jpg', published: true }
      ]
    },
    management: {
      title: 'Management',
      description: 'Meet the verified promoters, management members and school leaders listed by ENPEE International School.',
      image: 'https://www.enpeekkl.com/images/chairman.jpg',
      published: true,
      sections: [
        { heading: 'School leadership', body: 'Profiles below are based on the school’s published leadership information. The CMS can be used to update profiles and publish only verified details.', bullets: [], image: '', published: true }
      ]
    },
    chateauFrancais: {
      title: 'Château Français',
      description: 'Discover the design ideas behind ENPEE’s French-inspired school campus in Karaikal.',
      image: 'https://www.enpeekkl.com/images/school-img.jpg',
      published: true,
      sections: [
        { heading: 'Design philosophy', body: 'The school describes a design shaped by the character of its location, with open surroundings and a “less is more” approach to the campus.', bullets: [], image: 'https://www.enpeekkl.com/images/school-img.jpg', published: true },
        { heading: 'Design code', body: 'The design makes use of the site’s existing features and follows the linear shape of the land, with buildings arranged according to their functions.', bullets: [], image: 'https://www.enpeekkl.com/images/school-img-2.jpg', published: true },
        { heading: 'Form and function', body: 'Building orientation is intended to support natural light and ventilation. The official description also notes the value of retaining the existing landscape.', bullets: ['Natural lighting', 'Ventilation and open-air movement', 'Landscape retention'], image: '', published: true },
        { heading: 'Empathy and focus', body: 'The architecture draws on Karaikal’s French-colonial heritage while reflecting the character of the local setting.', bullets: [], image: 'https://www.enpeekkl.com/images/school-img-3.jpg', published: true }
      ]
    },
    wayWeWork: {
      title: 'The Way We Work',
      description: 'Explore ENPEE’s published curriculum approach and teaching and learning methods.',
      image: 'https://www.enpeekkl.com/images/curriculum-sub.jpg',
      published: true,
      sections: [
        { heading: 'Our curriculum', body: 'The school describes a CBSE-method approach supported by selected books and NCERT materials, with language options including Tamil, Arabic, French and Hindi.', bullets: ['Tamil', 'Arabic', 'French', 'Hindi'], image: 'https://www.enpeekkl.com/images/curriculum-sub.jpg', published: true },
        { heading: 'Developmentally appropriate practice', body: 'The school’s description of early education centres on understanding child development, individual learning needs and cultural context.', bullets: ['Know child development and learning', 'Respond to individual learning needs', 'Respect cultural context'], image: '', published: true },
        { heading: 'Our Mariner’s Star', body: 'The school outlines five educator practices to guide children’s learning journey.', bullets: ['Create a caring community of learners', 'Plan curriculum around important goals', 'Teach to enhance development and learning', 'Assess children’s development and learning', 'Build reciprocal relationships with families'], image: '', published: true },
        { heading: 'Teaching and learning methods', body: 'ENPEE describes a blend of active, collaborative and technology-supported learning.', bullets: ['Interactive learning', 'Collaborative learning', 'Experiential learning', 'Thematic and project-based learning', 'Multiple intelligences', 'Technology-based learning'], image: '', published: true }
      ]
    },
    programsOffered: {
      title: 'Programs Offered',
      description: 'Explore ENPEE’s published academic programs, Sports Academy and robotics learning.',
      image: 'https://www.enpeekkl.com/images/pic-pre-kg.jpg',
      published: true,
      sections: [
        { heading: 'Programs for every stage', body: 'The school’s official program information describes early childhood, kindergarten and Classes I to IX, with an emphasis on broad-based learner development. Program details and current offerings can be updated in the CMS.', bullets: [], image: '', published: true }
      ]
    },
    whatMakesUsDifferent: {
      title: 'What Makes Us Different',
      description: 'Explore the campus, educators, learning environment and family engagement highlighted by ENPEE.',
      image: 'https://www.enpeekkl.com/images/carosel/008.jpg',
      published: true,
      sections: [
        { heading: 'A whole-school experience', body: 'These differentiators are drawn from the school’s published description. Manage individual features in the CMS.', bullets: [], image: '', published: true }
      ]
    },
    contactUs: {
      title: 'Contact Us',
      description: 'Contact ENPEE International School in Karaikal for admissions and general enquiries.',
      image: 'https://www.enpeekkl.com/images/5-acre-campus-secured.jpg',
      published: true,
      sections: [
        { heading: 'We’re here to help', body: 'Reach the school by phone or email, get directions to the campus, or send an enquiry using the forms below.', bullets: [], image: '', published: true }
      ]
    }
  }
};

const seed = db.transaction(() => {
  const insertDocument = db.prepare('INSERT OR IGNORE INTO site_documents(key,payload,updated_at) VALUES(?,?,?)');
  for (const [key, payload] of Object.entries(defaults)) insertDocument.run(key, JSON.stringify(payload), now());
  const count = db.prepare('SELECT COUNT(*) AS count FROM content_items').get().count;
  if (!count) {
    const insertItem = db.prepare('INSERT INTO content_items(id,collection,payload,created_at,updated_at) VALUES(?,?,?,?,?)');
    const seeded = {
      facilities: [
        ['Smart Classrooms', 'Interactive, digitized learning spaces.', 'https://www.enpeekkl.com/images/interactive-digitized.jpg'],
        ['School Campus', 'A secure five-acre green campus.', 'https://www.enpeekkl.com/images/5-acre-campus-secured.jpg'],
        ['Sports Facilities', 'Facilities for sports, fitness and teamwork.', 'https://www.enpeekkl.com/images/community-football.jpg'],
        ['Transportation', 'Air-conditioned school transportation.', 'https://www.enpeekkl.com/images/air-buses.jpg']
      ],
      programs: [
        ['Pre-KG', 'Early childhood development and experiential learning.', 'Early Childhood'],
        ['LKG – UKG', 'Foundational learning and social development.', 'Kindergarten'],
        ['Classes I – IX', 'CBSE-based academic learning and overall development.', 'CBSE · NCERT']
      ],
      gallery: [
        ['Digitized Classrooms', 'Classroom', 'https://www.enpeekkl.com/images/interactive-digitized.jpg'],
        ['School Infrastructure', 'Facilities', 'https://www.enpeekkl.com/images/carosel/006.jpg'],
        ['Sports Ground', 'Sports', 'https://www.enpeekkl.com/images/community-football.jpg'],
        ['School Sports', 'Sports', 'https://www.enpeekkl.com/images/sports-001.jpg'],
        ['Advanced Sports Facilities', 'Sports', 'https://www.enpeekkl.com/images/carosel/002.jpg'],
        ['School Transport', 'Facilities', 'https://www.enpeekkl.com/images/air-buses.jpg']
      ],
      features: [
        ['Quality CBSE Education', 'NCERT-based curriculum and academic support.', 'graduation-cap'],
        ['Qualified Educators', 'Experienced educators committed to student growth.', 'users'],
        ['Interactive Digital Classrooms', 'Technology-supported classroom experiences.', 'screen'],
        ['Individual Attention', 'A supportive approach to each learner.', 'heart'],
        ['Safe Transportation', 'School transport serving student needs.', 'bus'],
        ['Holistic Development', 'Learning through academics, sports and activities.', 'leaf']
      ],
      activities: [
        ['Football', 'Sports', 'https://www.enpeekkl.com/images/community-football.jpg'],
        ['Basketball', 'Sports', 'https://www.enpeekkl.com/images/sports-001.jpg'],
        ['Yoga', 'Activities', 'https://www.enpeekkl.com/images/facilities/yoga-01.jpg'],
        ['Dance', 'Cultural', 'https://www.enpeekkl.com/images/facilities/dance-01.jpg'],
        ['Art & Craft', 'Cultural', 'https://www.enpeekkl.com/images/facilities/art-01.jpg'],
        ['Robotics', 'Learning', 'https://www.enpeekkl.com/images/carosel/009.jpg']
      ]
    };
    for (const [collection, rows] of Object.entries(seeded)) {
      rows.forEach((row, index) => {
        const [title, second, imageOrCategory] = row;
        const payload = collection === 'programs'
          ? {
            title, description: second, category: imageOrCategory, classLevel: title, eligibility: '', image: [
              'https://www.enpeekkl.com/images/pic-pre-kg.jpg',
              'https://www.enpeekkl.com/images/pic-lkg-ukg.jpg',
              'https://www.enpeekkl.com/images/pic-class-one-five.jpg'
            ][index], displayOrder: index + 1, published: true
          }
          : collection === 'features'
            ? { title, description: second, icon: imageOrCategory, displayOrder: index + 1, published: true }
            : { title, description: collection === 'facilities' ? second : '', category: collection === 'facilities' ? 'Facilities' : second, image: collection === 'facilities' ? imageOrCategory : row[2], displayOrder: index + 1, published: true };
        insertItem.run(id(), collection, JSON.stringify(payload), now(), now());
      });
    }
  }
});
seed();

const migrateSchoolPhotoDefaults = db.transaction(() => {
  const legacyStatistics = [
    { title: 'CBSE Curriculum', detail: 'NCERT-based learning' },
    { title: 'Digitized Classrooms', detail: 'Interactive learning' },
    { title: '5-Acre Campus', detail: 'Green and secure' },
    { title: 'Sports Academy', detail: 'Advanced sports assessment' }
  ];
  const homeRow = db.prepare('SELECT payload FROM site_documents WHERE key=?').get('home');
  if (homeRow) {
    const payload = JSON.parse(homeRow.payload);
    if (Array.isArray(payload.statistics)) {
      let changed = false;
      payload.statistics = payload.statistics.map((item, index) => {
        const legacy = legacyStatistics[index];
        const replacement = defaults.home.statistics[index];
        if (legacy && item && item.title === legacy.title && item.detail === legacy.detail) {
          changed = true;
          return { ...item, ...replacement };
        }
        return item;
      });
      if (changed) db.prepare('UPDATE site_documents SET payload=?,updated_at=? WHERE key=?').run(JSON.stringify(payload), now(), 'home');
    }
  }
  const documentImages = {
    home: {
      heroImage: ['https://images.unsplash.com/photo-1503676260728-1c00da094a0b?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/banner/home-banner-01.jpg']
    },
    about: {
      photos: [
        ['https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/5-acre-campus-secured.jpg'],
        ['https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/carosel/003.jpg']
      ]
    }
  };
  for (const [key, fields] of Object.entries(documentImages)) {
    const row = db.prepare('SELECT payload FROM site_documents WHERE key=?').get(key);
    if (!row) continue;
    const payload = JSON.parse(row.payload);
    let changed = false;
    if (fields.heroImage && payload.heroImage === fields.heroImage[0]) {
      payload.heroImage = fields.heroImage[1];
      changed = true;
    }
    if (fields.photos && Array.isArray(payload.photos)) {
      payload.photos = payload.photos.map((image, index) => {
        const [oldImage, schoolImage] = fields.photos[index] || [];
        if (oldImage && image === oldImage) { changed = true; return schoolImage; }
        return image;
      });
    }
    if (changed) db.prepare('UPDATE site_documents SET payload=?,updated_at=? WHERE key=?').run(JSON.stringify(payload), now(), key);
  }
  const seededPhotoUpdates = {
    facilities: {
      'Smart Classrooms': ['https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/interactive-digitized.jpg'],
      'Science Laboratory': ['https://images.unsplash.com/photo-1532094349884-543bc11b234d?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/carosel/006.jpg'],
      'Sports Facilities': ['https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/community-football.jpg'],
      'Transportation': ['https://images.unsplash.com/photo-1553440569-bcc63803a83d?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/air-buses.jpg']
    },
    programs: {
      'Pre-KG': ['https://images.unsplash.com/photo-1513258496099-48168024aec0?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/pic-pre-kg.jpg'],
      'LKG – UKG': ['https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/pic-lkg-ukg.jpg'],
      'Classes I – IX': ['https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/pic-class-one-five.jpg']
    },
    gallery: {
      'Digitized Classrooms': ['https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/interactive-digitized.jpg'],
      'Science Laboratories': ['https://images.unsplash.com/photo-1532094349884-543bc11b234d?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/carosel/006.jpg'],
      'Sports Ground': ['https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/community-football.jpg'],
      'Skating Rink': ['https://images.unsplash.com/photo-1547347298-4074fc3086f0?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/sports-001.jpg'],
      'Basketball & Badminton': ['https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/sports-002.jpg'],
      'Archery': ['https://images.unsplash.com/photo-1517836357463-d25dfeac3438?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/carosel/002.jpg'],
      'School Transport': ['https://images.unsplash.com/photo-1553440569-bcc63803a83d?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/air-buses.jpg']
    },
    activities: {
      'Football': ['https://images.unsplash.com/photo-1547347298-4074fc3086f0?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/community-football.jpg'],
      'Basketball': ['https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/sports-002.jpg'],
      'Skating': ['https://images.unsplash.com/photo-1547347298-4074fc3086f0?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/sports-001.jpg'],
      'Yoga': ['https://images.unsplash.com/photo-1518611012118-696072aa579a?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/facilities/yoga-01.jpg'],
      'Dance': ['https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/facilities/dance-01.jpg'],
      'Art & Craft': ['https://images.unsplash.com/photo-1513364776144-60967b0f800f?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/facilities/art-01.jpg'],
      'Robotics': ['https://images.unsplash.com/photo-1581092921461-eab62e97a780?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/carosel/009.jpg'],
      'Indoor Games': ['https://images.unsplash.com/photo-1516627145497-ae6968895b74?auto=format&fit=crop&w=1200&q=80', 'https://www.enpeekkl.com/images/carosel/003.jpg']
    }
  };
  const items = db.prepare('SELECT id,collection,payload FROM content_items WHERE collection IN (?,?,?,?)').all('facilities', 'programs', 'gallery', 'activities');
  for (const item of items) {
    const payload = JSON.parse(item.payload);
    if (['facilities', 'gallery'].includes(item.collection) && payload.title === 'Library' &&
      payload.image === 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?auto=format&fit=crop&w=1200&q=80') {
      payload.image = '';
      payload.published = false;
      db.prepare('UPDATE content_items SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify(payload), now(), item.id);
      continue;
    }
    const replacement = seededPhotoUpdates[item.collection]?.[payload.title];
    if (replacement && payload.image === replacement[0]) {
      payload.image = replacement[1];
      db.prepare('UPDATE content_items SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify(payload), now(), item.id);
    }
  }
});
migrateSchoolPhotoDefaults();

const migrateLogoAndMarqueeFields = db.transaction(() => {
  const migration = 'logo-marquee-fields-v1';
  if (db.prepare('SELECT name FROM app_migrations WHERE name=?').get(migration)) return;
  const row = db.prepare('SELECT payload FROM site_documents WHERE key=?').get('home');
  if (row) {
    const payload = JSON.parse(row.payload);
    let changed = false;
    if (typeof payload.marqueeEnabled !== 'boolean') {
      payload.marqueeEnabled = true;
      changed = true;
    }
    if (typeof payload.logoImage !== 'string' || !payload.logoImage.trim()) {
      const logo = db.prepare("SELECT filename FROM media WHERE mime_type LIKE 'image/%' AND lower(original_name) LIKE '%logo%' ORDER BY created_at DESC").all()
        .find((item) => fs.existsSync(path.join(uploadDir, item.filename)));
      if (logo) {
        payload.logoImage = `/uploads/${logo.filename}`;
        changed = true;
      }
    }
    if (changed) db.prepare('UPDATE site_documents SET payload=?,updated_at=? WHERE key=?').run(JSON.stringify(payload), now(), 'home');
  }
  db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run(migration, now());
});
migrateLogoAndMarqueeFields();
const migrateSchoolSectionFields = db.transaction(() => {
  const migration = 'school-section-fields-v1';
  if (db.prepare('SELECT name FROM app_migrations WHERE name=?').get(migration)) return;
  for (const [key, additions] of Object.entries({
    home: { academicYear: defaults.home.academicYear },
    about: {
      history: '', philosophy: '', learningEnvironment: '', infrastructure: '',
      chateauDescription: '', chateauImage: '', chateauPublished: false,
      wayWeWork: '', wayWeWorkPublished: false,
      parentsCornerMessage: '', parentsCornerImage: '', parentsCornerPublished: false
    }
  })) {
    const row = db.prepare('SELECT payload FROM site_documents WHERE key=?').get(key);
    if (!row) continue;
    const payload = JSON.parse(row.payload);
    let changed = false;
    for (const [field, value] of Object.entries(additions)) {
      if (!Object.hasOwn(payload, field)) {
        payload[field] = value;
        changed = true;
      }
    }
    if (changed) db.prepare('UPDATE site_documents SET payload=?,updated_at=? WHERE key=?').run(JSON.stringify(payload), now(), key);
  }
  const about = JSON.parse(db.prepare('SELECT payload FROM site_documents WHERE key=?').get('about').payload);
  about.chateauDescription = about.chateauDescription || 'The school describes Château Français as drawing on Karaikal’s local context and French-colonial heritage, with a design that supports natural light and ventilation.';
  about.chateauPublished = true;
  about.wayWeWork = about.wayWeWork || 'The school describes a CBSE and NCERT-based approach using developmentally appropriate, interactive, experiential, project-based, thematic and collaborative learning supported by technology.';
  about.wayWeWorkPublished = true;
  db.prepare('UPDATE site_documents SET payload=?,updated_at=? WHERE key=?').run(JSON.stringify(about), now(), 'about');
  const verifiedEntries = {
    leadership: [
      { title: 'Rtn. PHF. Hajee L. Kamal Batcha', designation: 'Founder and Chairman', category: 'Promoters' },
      { title: 'Dr. K. Mujibur Rahman', designation: 'Managing Trustee', category: 'School Management' },
      { title: 'Dr. K. Mohamed Ali', designation: 'Managing Trustee', category: 'School Management' },
      { title: 'Mr. H M A Khan', designation: 'CEO', category: 'Leadership Team' },
      { title: 'Arrchana Chellappa', designation: 'Vice President – Academics & Operations', category: 'Leadership Team' }
    ],
    technologyPartners: [
      { title: 'Yellowandgray', category: 'Technology Partner', description: 'Listed as a technology partner on the official ENPEE International School website.' },
      { title: 'Morfosis', category: 'Technology Partner', description: 'Listed as a technology partner on the official ENPEE International School website.' }
    ],
    infrastructureProviders: [
      { title: 'Krueger International Furniture', category: 'Infrastructure Provider', description: 'Listed on the official ENPEE International School website.' },
      { title: 'Force Motors', category: 'Infrastructure Provider', description: 'Listed on the official ENPEE International School website.' }
    ]
  };
  const insertContent = db.prepare('INSERT INTO content_items(id,collection,payload,created_at,updated_at) VALUES(?,?,?,?,?)');
  for (const [collection, entries] of Object.entries(verifiedEntries)) {
    entries.forEach((entry, index) => {
      if (db.prepare("SELECT 1 FROM content_items WHERE collection=? AND json_extract(payload,'$.title')=?").get(collection, entry.title)) return;
      const timestamp = now();
      insertContent.run(id(), collection, JSON.stringify({ ...entry, displayOrder: index + 1, published: true }), timestamp, timestamp);
    });
  }
  db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run(migration, now());
});
migrateSchoolSectionFields();
const migrateFooterPageLabels = db.transaction(() => {
  const migration = 'footer-page-labels-v1';
  if (db.prepare('SELECT name FROM app_migrations WHERE name=?').get(migration)) return;
  const row = db.prepare('SELECT payload FROM site_documents WHERE key=?').get('sections');
  if (row) {
    const payload = JSON.parse(row.payload);
    const legacyValues = {
      footerDescription: ['Karaikal’s 1st premium school. CBSE affiliated (Aff. No. 2930085). Recognised by Puducherry Govt., Code No. UN-03.', defaults.sections.footerDescription],
      footerAcademicsLinkText: ['Academics', 'Programs Offered'],
      footerCampusLinkText: ['Campus & Facilities', 'Château Français'],
      footerActivitiesLinkText: ['Activities', 'The Way We Work'],
      footerGalleryLinkText: ['Gallery', 'What Makes Us Different'],
      footerContactLinkText: ['Contact', 'Contact Us'],
      navContact: ['Contact', 'Contact Us']
    };
    for (const [field, [legacy, replacement]] of Object.entries(legacyValues)) {
      if (payload[field] === legacy) payload[field] = replacement;
    }
    for (const field of [
      'footerPromotersLinkText', 'footerManagementLinkText',
      'parentEnquiryHeading', 'parentEnquiryNameLabel', 'parentEnquiryEmailLabel',
      'parentEnquiryMessageLabel', 'parentEnquirySubmitText'
    ]) {
      if (!Object.hasOwn(payload, field)) payload[field] = defaults.sections[field];
    }
    db.prepare('UPDATE site_documents SET payload=?,updated_at=? WHERE key=?').run(JSON.stringify(payload), now(), 'sections');
  }
  db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run(migration, now());
});
migrateFooterPageLabels();
const migratePagesAndMediaContent = db.transaction(() => {
  const migration = 'pages-youtube-content-v1';
  if (db.prepare('SELECT name FROM app_migrations WHERE name=?').get(migration)) return;
  const insertItem = db.prepare('INSERT INTO content_items(id,collection,payload,created_at,updated_at) VALUES(?,?,?,?,?)');
  const addIfMissing = (collection, payload) => {
    if (db.prepare("SELECT 1 FROM content_items WHERE collection=? AND lower(json_extract(payload,'$.title'))=lower(?)").get(collection, payload.title)) return;
    const timestamp = now();
    insertItem.run(id(), collection, JSON.stringify(payload), timestamp, timestamp);
  };
  const officialVideos = [
    { title: 'ENPEE International School, Karaikal – Admissions Open', videoUrl: 'https://www.youtube.com/watch?v=51JIyUQ92BM', category: 'Admissions', description: 'An official school video introducing admissions for Pre-KG to Standard IX.', displayOrder: 1 },
    { title: 'ENPEE International School – Annual Sports Day', videoUrl: 'https://www.youtube.com/watch?v=jK2BNKqiNeU', category: 'Sports', description: 'Highlights from the school’s fourth annual Sports Day, held in March 2023.', displayOrder: 2 },
    { title: 'ENPEE International School – Annual Day Celebrations', videoUrl: 'https://www.youtube.com/watch?v=7oKB8BsWht4', category: 'School events', description: 'Highlights from the school’s fourth Annual Day, held in February 2023.', displayOrder: 3 }
  ];
  for (const video of officialVideos) {
    const videoId = extractYouTubeVideoId(video.videoUrl);
    if (db.prepare("SELECT 1 FROM content_items WHERE collection='youtubeVideos' AND json_extract(payload,'$.videoId')=?").get(videoId)) continue;
    addIfMissing('youtubeVideos', { ...video, videoId, image: `/assets/images/video-thumbnails/${videoId}.jpg`, published: true });
  }
  addIfMissing('programs', {
    title: 'ENPEE Sports Academy', classLevel: 'Sports', category: 'Sports Academy',
    description: 'The school describes a sports complex with facilities including track and field, skating, archery, basketball, badminton, table tennis and football.',
    learningObjectives: 'Build physical skills through school sports and activities.',
    curriculum: 'Sports and physical activities', eligibility: '', image: 'https://www.enpeekkl.com/images/sports-001.jpg',
    displayOrder: 4, published: true
  });
  addIfMissing('programs', {
    title: 'Robotics', classLevel: 'School learning', category: 'Technology',
    description: 'The school describes introducing students to robotics fundamentals as part of technology-supported learning.',
    learningObjectives: 'Explore introductory robotics and creative problem-solving.',
    curriculum: 'Introductory robotics', eligibility: '', image: 'https://www.enpeekkl.com/images/carosel/009.jpg',
    displayOrder: 5, published: true
  });
  const verifiedFeatures = [
    ['Secular Campus', 'The school identifies its campus as secular.'],
    ['Committed, Qualified Educators', 'A school feature highlighted in the official description.'],
    ['Air-Conditioned Learning Environment', 'The school describes an air-conditioned learning environment.'],
    ['Laboratories and Mixed-Age Activity Studio', 'The official description lists laboratories and a mixed-age activity studio.'],
    ['GPS-Enabled School Transport', 'The school describes air-conditioned, GPS-enabled transport with dedicated caretakers.'],
    ['Child-Friendly, Participatory Classrooms', 'The school highlights child-friendly classrooms and learner participation.'],
    ['Campus Monitoring', 'The school describes campus-wide digital monitoring.'],
    ['Parent Engagement', 'Community days, parent engagement programs and coffee mornings are listed by the school.'],
    ['Educator Development', 'The school describes professional development and educational and recreational programs for educators.'],
    ['Extracurricular Activities', 'The school highlights extracurricular activities as part of student life.']
  ];
  verifiedFeatures.forEach(([title, description], index) => addIfMissing('features', {
    title, description, icon: '', displayOrder: index + 7, published: true
  }));
  const verifiedProfiles = [
    ['Rtn. PHF. Hajee L. Kamal Batcha', 'Founder and Chairman', 'Promoters', 'The school identifies him as its Founder and Chairman and describes his philanthropic work in education and healthcare.', 'https://www.enpeekkl.com/images/chairman.jpg'],
    ['Dr. K. Mujibur Rahman', 'Managing Trustee', 'School Management', 'The official profile identifies him as a professor and Head of Community Medicine at Vinayaka Missions Medical College, Karaikal, and as Managing Director of National Pharma Hospital and Research Institute.', ''],
    ['Dr. K. Mohamed Ali', 'Managing Trustee', 'School Management', 'The official profile identifies him as a professor in Community Medicine at Vinayaka Missions Medical College, Karaikal, and as Director of National Pharma Hospital and Research Institute.', ''],
    ['Mr. H M A Khan', 'Chief Executive Officer', 'Leadership Team', 'The official profile describes 35 years of banking experience and senior administrative and operating roles.', ''],
    ['Arrchana Chellappa', 'Vice President – Academics & Operations', 'Leadership Team', 'The official profile describes experience across education operations, teacher training and academic leadership.', ''],
    ['Mr. J. Raja Kalifulla, B.Sc, B.L.', 'Member, Board of Management', 'Board of Management', 'The official profile identifies him as a former Government Pleader and Senior Advocate who practised in the Madras High Court.', ''],
    ['Mr. Jafer Sadique Muthuvappa', 'Member, Board of Management', 'Board of Management', 'The official profile describes his pharmacy career in Albany, New York.', '']
  ];
  for (const [index, [title, designation, category, description, image]] of verifiedProfiles.entries()) {
    const existing = db.prepare("SELECT id,payload FROM content_items WHERE collection='leadership' AND lower(json_extract(payload,'$.title'))=lower(?)").get(title);
    if (existing) {
      const payload = JSON.parse(existing.payload);
      if (!payload.description || (!payload.image && image)) {
        payload.description = payload.description || description;
        payload.image = payload.image || image;
        db.prepare('UPDATE content_items SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify(payload), now(), existing.id);
      }
      continue;
    }
    const timestamp = now();
    insertItem.run(id(), 'leadership', JSON.stringify({
      title, designation, category, description, image, displayOrder: index + 1, published: true
    }), timestamp, timestamp);
  }
  db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run(migration, now());
});
migratePagesAndMediaContent();

const migrateMomentsAtEnpeeGallery = db.transaction(() => {
  const migration = 'campus-life-moments-gallery-v1';
  if (db.prepare('SELECT name FROM app_migrations WHERE name=?').get(migration)) return;
  const insertItem = db.prepare('INSERT INTO content_items(id,collection,payload,created_at,updated_at) VALUES(?,?,?,?,?)');
  const addIfMissing = (collection, payload) => {
    if (db.prepare("SELECT 1 FROM content_items WHERE collection=? AND lower(json_extract(payload,'$.title'))=lower(?)").get(collection, payload.title)) return;
    const timestamp = now();
    insertItem.run(id(), collection, JSON.stringify(payload), timestamp, timestamp);
  };

  const initialMoments = [
    { title: 'Annual Day Celebration', category: 'Events', image: '/assets/images/certificate/first-annual-day-celebration-small.jpg', displayOrder: 1, published: true },
    { title: 'Our Secured Campus', category: 'Campus', image: '/assets/images/5-acre-campus-secured.jpg', displayOrder: 2, published: true },
    { title: 'Digitized Classrooms', category: 'Learning', image: '/assets/images/interactive-digitized.jpg', displayOrder: 3, published: true },
    { title: 'Sports Academy', category: 'Sports', image: '/assets/images/community-football.jpg', displayOrder: 4, published: true },
    { title: 'School Transport', category: 'Campus', image: '/assets/images/carosel/air-buses.jpg', displayOrder: 5, published: true },
    { title: 'Robotics', category: 'Learning', image: '/assets/images/carosel/009.jpg', displayOrder: 6, published: true },
    { title: 'Science Laboratories', category: 'Learning', image: '/assets/images/carosel/006.jpg', displayOrder: 7, published: true },
    { title: 'Skating Rink', category: 'Sports', image: '/assets/images/sports-001.jpg', displayOrder: 8, published: true },
    { title: 'Basketball & Badminton', category: 'Sports', image: '/assets/images/carosel/sports-001.jpg', displayOrder: 9, published: true },
    { title: 'Archery & Athletics', category: 'Sports', image: '/assets/images/carosel/002.jpg', displayOrder: 10, published: true }
  ];

  for (const m of initialMoments) {
    const existing = db.prepare("SELECT id, payload FROM content_items WHERE collection='gallery' AND lower(json_extract(payload,'$.title'))=lower(?)").get(m.title);
    if (existing) {
      let p = {};
      try { p = JSON.parse(existing.payload); } catch {}
      p.displayOrder = m.displayOrder;
      if (!p.image && m.image) p.image = m.image;
      if (!p.category && m.category) p.category = m.category;
      p.published = true;
      db.prepare("UPDATE content_items SET payload=?, updated_at=? WHERE id=?").run(JSON.stringify(p), now(), existing.id);
    } else {
      addIfMissing('gallery', m);
    }
  }

  // Clean up any empty unpublished placeholder item
  db.prepare("DELETE FROM content_items WHERE collection='gallery' AND (json_extract(payload,'$.image')='' OR json_extract(payload,'$.image') IS NULL)").run();

  db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run(migration, now());
});
migrateMomentsAtEnpeeGallery();

const migrateLearningBeyondClassroomActivities = db.transaction(() => {
  const migration = 'activities-learning-beyond-classroom-v1';
  if (db.prepare('SELECT name FROM app_migrations WHERE name=?').get(migration)) return;
  const insertItem = db.prepare('INSERT INTO content_items(id,collection,payload,created_at,updated_at) VALUES(?,?,?,?,?)');
  const addIfMissing = (collection, payload) => {
    if (db.prepare("SELECT 1 FROM content_items WHERE collection=? AND lower(json_extract(payload,'$.title'))=lower(?)").get(collection, payload.title)) return;
    const timestamp = now();
    insertItem.run(id(), collection, JSON.stringify(payload), timestamp, timestamp);
  };

  const initialActivities = [
    { title: 'Football', category: 'Sports', image: '/assets/images/community-football.jpg', displayOrder: 1, published: true },
    { title: 'Basketball', category: 'Sports', image: '/assets/images/carosel/sports-001.jpg', displayOrder: 2, published: true },
    { title: 'Skating', category: 'Sports', image: '/assets/images/carosel/004.jpg', displayOrder: 3, published: true },
    { title: 'Yoga', category: 'Activities', image: '/assets/images/carosel/003.jpg', displayOrder: 4, published: true },
    { title: 'Dance', category: 'Cultural', image: '/assets/images/certificate/first-annual-day-celebration-small.jpg', displayOrder: 5, published: true },
    { title: 'Art & Craft', category: 'Cultural', image: '/assets/images/carosel/005.jpg', displayOrder: 6, published: true },
    { title: 'Robotics', category: 'Learning', image: '/assets/images/carosel/009.jpg', displayOrder: 7, published: true },
    { title: 'Indoor Games', category: 'Activities', image: '/assets/images/carosel/002.jpg', displayOrder: 8, published: true }
  ];

  for (const a of initialActivities) {
    const existing = db.prepare("SELECT id, payload FROM content_items WHERE collection='activities' AND lower(json_extract(payload,'$.title'))=lower(?)").get(a.title);
    if (existing) {
      let p = {};
      try { p = JSON.parse(existing.payload); } catch {}
      p.displayOrder = a.displayOrder;
      if (!p.image || p.image.startsWith('http')) {
        p.image = a.image;
      }
      if (!p.category && a.category) p.category = a.category;
      p.published = true;
      db.prepare("UPDATE content_items SET payload=?, updated_at=? WHERE id=?").run(JSON.stringify(p), now(), existing.id);
    } else {
      addIfMissing('activities', a);
    }
  }

  db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run(migration, now());
});
migrateLearningBeyondClassroomActivities();

function syncStaticMedia() {
  const imageExts = new Set(['.webp', '.jpg', '.jpeg', '.png', '.avif', '.mp4', '.webm']);
  const mimeMap = {
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm'
  };

  function walk(dir) {
    let res = [];
    if (!fs.existsSync(dir)) return res;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) res = res.concat(walk(full));
      else {
        const ext = path.extname(entry.name).toLowerCase();
        if (imageExts.has(ext)) res.push(full);
      }
    }
    return res;
  }

  const existingMedia = new Set(db.prepare('SELECT filename FROM media').all().map((r) => r.filename));
  const insertStmt = db.prepare('INSERT INTO media(id,filename,original_name,mime_type,size,category,created_at) VALUES(?,?,?,?,?,?,?)');

  const files = walk(path.join(root, 'assets'));
  const syncTx = db.transaction(() => {
    for (const file of files) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      if (existingMedia.has(rel) || existingMedia.has(path.basename(rel))) continue;

      const ext = path.extname(file).toLowerCase();
      const mime = mimeMap[ext] || 'application/octet-stream';
      const stats = fs.statSync(file);

      let category = 'Website photos';
      if (rel.includes('video-thumbnails')) category = 'Video thumbnails';
      else if (rel.includes('carosel')) category = 'Hero & Carousels';
      else if (rel.includes('downloads')) category = 'Flyers & Brochures';
      else if (rel.includes('mascot')) category = 'Mascot';
      else if (rel.includes('campus') || rel.includes('school-img') || rel.includes('architecture')) category = 'Campus & Architecture';

      const base = path.basename(file);
      const originalName = base;
      const recordId = id();
      const createdAt = stats.mtime ? stats.mtime.toISOString() : now();

      insertStmt.run(recordId, rel, originalName, mime, stats.size, category, createdAt);
      existingMedia.add(rel);
    }
  });

  try {
    syncTx();
  } catch (err) {
    console.warn('Failed to sync static media to CMS:', err.message);
  }
}
syncStaticMedia();

const adminsCount = db.prepare('SELECT COUNT(*) AS count FROM admins').get().count;
if (!adminsCount) {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !password || password.length < 14 || password.length > 200) {
    throw new Error('First launch requires ADMIN_EMAIL and ADMIN_PASSWORD (14–200 characters). Copy .env.example to .env and configure them.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
  db.prepare('INSERT INTO admins(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(id(), email, hash, now());
}

app.disable('x-powered-by');
const allowedCorsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const trustProxyEnv = process.env.TRUST_PROXY?.toLowerCase()?.trim();
app.set('trust proxy', (trustProxyEnv === 'true' || trustProxyEnv === '1' || process.env.NODE_ENV === 'production') ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://www.enpeekkl.com', 'https://images.unsplash.com', 'https://*.unsplash.com', 'https://i.ytimg.com'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", 'https://maps.google.com', 'https://www.google.com', 'https://www.youtube-nocookie.com'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: allowedCorsOrigins.length ? { policy: 'cross-origin' } : { policy: 'same-origin' }
}));
if (allowedCorsOrigins.length) {
  app.use((req, res, next) => {
    const origin = req.headers.origin?.replace(/\/+$/, '');
    if (origin && allowedCorsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
}
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));
app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));
app.get('/ready', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.status(200).json({ status: 'ready', uptime: process.uptime(), db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'unready', error: err.message });
  }
});
app.use('/uploads', express.static(uploadDir, { index: false, dotfiles: 'deny', maxAge: '0', setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));
app.get('/assets/lottie.min.js', (_req, res) => {
  const bundled = path.join(root, 'assets', 'lottie.min.js');
  if (fs.existsSync(bundled)) return res.sendFile(bundled);
  return res.sendFile(path.join(root, 'node_modules', 'lottie-web', 'build', 'player', 'lottie.min.js'));
});
app.use('/assets', express.static(path.join(root, 'assets'), { index: false, dotfiles: 'deny', maxAge: '1h', setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));
app.get('/admin', (_req, res) => res.sendFile(path.join(root, 'admin.html')));
app.get('/admin/*path', (_req, res) => res.sendFile(path.join(root, 'admin.html')));
const publicPage = path.join(root, 'index.html');
app.get('/', (_req, res) => res.sendFile(publicPage));
const publicPageRoutes = [
  { path: '/about', key: 'about' },
  { path: '/promoters', key: 'promoters' },
  { path: '/management', key: 'management' },
  { path: '/advisory-board', key: 'advisoryBoard' },
  { path: '/chateau-francais', key: 'chateauFrancais' },
  { path: '/infrastructure', key: 'infrastructure' },
  { path: '/digital-classrooms', key: 'digitalClassrooms' },
  { path: '/sports-academy', key: 'sportsAcademy' },
  { path: '/student-activities', key: 'studentActivities' },
  { path: '/way-we-work', key: 'wayWeWork' },
  { path: '/programs-offered', key: 'programsOffered' },
  { path: '/what-makes-us-different', key: 'whatMakesUsDifferent' },
  { path: '/photo-gallery', key: 'photoGallery' },
  { path: '/gallery', key: 'photoGallery' },
  { path: '/video-gallery', key: 'videoGallery' },
  { path: '/events-celebrations', key: 'eventsCelebrations' },
  { path: '/events', key: 'eventsCelebrations' },
  { path: '/downloads', key: 'downloads' },
  { path: '/cbse-mandatory-disclosure', key: 'cbseMandatoryDisclosure' },
  { path: '/contact-us', key: 'contactUs' }
];
for (const [source, destination] of [
  ['/index.php', '/'],
  ['/about.php', '/about'],
  ['/promoters.php', '/promoters'],
  ['/management.php', '/management'],
  ['/advisory-board.php', '/management#advisory-board'],
  ['/chateau-francais.php', '/chateau-francais'],
  ['/infrastructure.php', '/infrastructure'],
  ['/digital-classrooms.php', '/digital-classrooms'],
  ['/sports-academy.php', '/sports-academy'],
  ['/student-activities.php', '/student-activities'],
  ['/way-we-work.php', '/way-we-work'],
  ['/programs-offered.php', '/programs-offered'],
  ['/what-makes-different.php', '/what-makes-us-different'],
  ['/gallery.php', '/photo-gallery'],
  ['/videos.php', '/video-gallery'],
  ['/events.php', '/events-celebrations'],
  ['/downloads.php', '/downloads'],
  ['/contact.php', '/contact-us']
]) app.get(source, (_req, res) => res.redirect(301, destination));
app.get('/cbse-mandatory-disclosure.php', (_req, res) => res.redirect(301, 'https://www.enpeekkl.com/cbse-mandatory-disclosure.php'));
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
for (const route of publicPageRoutes) {
  app.get(route.path, (req, res, next) => {
    const row = db.prepare('SELECT payload FROM site_documents WHERE key=?').get('pages');
    const page = row && JSON.parse(row.payload)[route.key];
    if (!page || !page.published) return res.sendFile(publicPage);
    fs.promises.readFile(publicPage, 'utf8').then((html) => {
      const title = `${page.title} | ENPEE International School`;
      const description = String(page.description || page.title).slice(0, 160);
      const canonical = `${process.env.PUBLIC_ORIGIN || `http://localhost:${port}`}${route.path}`;
      const rendered = html
        .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
        .replace(/<meta\s+name="description"[\s\S]*?content="[^"]*">/, `<meta name="description" content="${escapeHtml(description)}">`)
        .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${escapeHtml(canonical)}">`);
      res.set('Cache-Control', 'no-store').type('html').send(rendered);
    }).catch(next);
  });
}
app.get('/contact', (_req, res) => res.redirect(301, '/contact-us'));
function publishedContentBySlug(collection, slug) {
  return db.prepare('SELECT id,payload FROM content_items WHERE collection=?').all(collection)
    .map((row) => ({ id: row.id, ...JSON.parse(row.payload) }))
    .find((item) => item.published && contentSlug(item.title, item.id) === slug);
}
function sendContentDetail(collection, slug, res, next) {
  const item = publishedContentBySlug(collection, slug);
  if (!item) return res.status(404).sendFile(publicPage);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  fs.promises.readFile(publicPage, 'utf8').then((html) => {
    const title = `${item.title} | ENPEE International School`;
    const description = String(item.description || item.title).slice(0, 160);
    const page = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
      .replace(/<meta\s+name="description"[\s\S]*?content="[^"]*">/, `<meta name="description" content="${escapeHtml(description)}">`);
    res.set('Cache-Control', 'no-store').type('html').send(page);
  }).catch(next);
}
app.get('/programs/:slug', (req, res, next) => sendContentDetail('programs', req.params.slug, res, next));
app.get('/events/:slug', (req, res, next) => sendContentDetail('events', req.params.slug, res, next));
const siteOrigin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${siteOrigin}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (_req, res) => {
  const pages = [`${siteOrigin}/`];
  const pagesDocument = JSON.parse(db.prepare('SELECT payload FROM site_documents WHERE key=?').get('pages').payload);
  for (const route of publicPageRoutes) {
    if (pagesDocument[route.key]?.published) pages.push(`${siteOrigin}${route.path}`);
  }
  for (const [collection, route] of [['programs', 'programs'], ['events', 'events']]) {
    const items = db.prepare('SELECT id,payload FROM content_items WHERE collection=?').all(collection);
    for (const row of items) {
      const item = JSON.parse(row.payload);
      if (item.published) pages.push(`${siteOrigin}/${route}/${contentSlug(item.title, row.id)}`);
    }
  }
  const xmlEscape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character]);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((url) => `<url><loc>${xmlEscape(url)}</loc></url>`).join('')}</urlset>`);
});

const limitResponse = (_req, res) => res.status(429).json({ error: 'Too many requests. Please wait and try again later.' });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 150, standardHeaders: 'draft-8', legacyHeaders: false, handler: limitResponse });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false, handler: limitResponse });
app.use('/api', apiLimiter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/forgot', rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, handler: limitResponse }));
app.use('/api/auth/reset', rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false, handler: limitResponse }));
app.use('/api/auth/password', rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false, handler: limitResponse }));
app.use('/api/public/enquiries', rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, handler: limitResponse }));

const hashToken = (token) => crypto.createHmac('sha256', sessionSecret).update(token).digest('hex');
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
const passwordMatches = (password, stored) => {
  const [salt, expected] = stored.split(':');
  return Boolean(salt && expected && safeEqual(crypto.scryptSync(password, salt, 64).toString('hex'), expected));
};
const cookieOptions = (maxAge) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production' || allowedCorsOrigins.length > 0,
  sameSite: allowedCorsOrigins.length > 0 ? 'none' : 'strict',
  path: '/',
  maxAge
});
const logAction = (admin, action, target) => db.prepare(
  'INSERT INTO activity_log(id,admin_email,action,target,created_at) VALUES(?,?,?,?,?)'
).run(id(), admin.email, action, target, now());

function auth(requiredRole = 'admin') {
  return (req, res, next) => {
    const token = req.cookies?.enpee_session;
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    const session = db.prepare(`SELECT s.*, a.email, a.role FROM sessions s JOIN admins a ON a.id=s.admin_id
      WHERE s.id_hash=? AND s.expires_at>?`).get(hashToken(token), Date.now());
    if (!session) {
      res.clearCookie('enpee_session', cookieOptions(0));
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    if (requiredRole && session.role !== requiredRole) return res.status(403).json({ error: 'Insufficient permissions.' });
    req.admin = { id: session.admin_id, email: session.email, role: session.role };
    req.csrfToken = session.csrf_token;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-csrf-token') !== session.csrf_token) {
      return res.status(403).json({ error: 'Invalid CSRF token.' });
    }
    next();
  };
}
app.use((req, _res, next) => {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
  req.cookies = cookies;
  next();
});
const privateApi = auth();
const allowedCollections = new Set([
  'facilities', 'programs', 'gallery', 'features', 'activities', 'announcements', 'testimonials',
  'events', 'sports', 'technologyPartners', 'infrastructureProviders', 'leadership', 'parentResources', 'youtubeVideos'
]);
const booleanDocumentFields = new Set(['marqueeEnabled', 'chateauPublished', 'wayWeWorkPublished', 'parentsCornerPublished']);
const payloadSchema = {
  title: (v) => requiredText(v, 'title', 120),
  description: (v) => optionalText(v, 'description', 3000),
  image: (v) => optionalText(v, 'image', 1000),
  video: (v) => optionalText(v, 'video', 1000),
  category: (v) => optionalText(v, 'category', 80),
  displayOrder: (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 10000 ? Number(v) : 0,
  published: (v) => v === true,
  important: (v) => v === true,
  approved: (v) => v === true,
  classLevel: (v) => optionalText(v, 'class level', 80),
  eligibility: (v) => optionalText(v, 'eligibility', 500),
  icon: (v) => optionalText(v, 'icon', 80),
  publicationDate: (v) => optionalText(v, 'publication date', 40),
  designation: (v) => optionalText(v, 'designation', 100),
  parentName: (v) => optionalText(v, 'parent name', 120),
  eventDate: (v) => optionalText(v, 'event date', 40),
  websiteUrl: (v) => {
    const value = optionalText(v, 'website URL', 500);
    if (!value) return '';
    let url;
    try { url = new URL(value); } catch { throw new Error('Website URL must be a valid HTTPS address.'); }
    if (url.protocol !== 'https:') throw new Error('Website URL must use HTTPS.');
    return url.href;
  },
  curriculum: (v) => optionalText(v, 'curriculum', 500),
  learningObjectives: (v) => optionalText(v, 'learning objectives', 3000)
  , videoUrl: (v) => {
    const value = optionalText(v, 'YouTube URL', 1000);
    if (!value) return '';
    const videoId = extractYouTubeVideoId(value);
    if (!videoId) throw new Error('Enter a valid YouTube video URL.');
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
};
function extractYouTubeVideoId(value) {
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'].includes(url.hostname)) return '';
  const parts = url.pathname.split('/').filter(Boolean);
  const candidate = url.hostname === 'youtu.be' ? parts[0]
    : url.pathname === '/watch' ? url.searchParams.get('v')
      : ['embed', 'shorts', 'live'].includes(parts[0]) ? parts[1] : '';
  return /^[A-Za-z0-9_-]{11}$/.test(candidate || '') ? candidate : '';
}
function requiredText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label} is required and must be at most ${max} characters.`);
  return value.trim();
}
function optionalText(value, label, max) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be a string no longer than ${max} characters.`);
  return value.trim();
}
function positiveInt(value, fallback, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}
function cleanPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A content object is required.');
  const output = {};
  for (const [key, validate] of Object.entries(payloadSchema)) {
    if (Object.hasOwn(input, key)) output[key] = validate(input[key]);
  }
  output.title = requiredText(input.title, 'title', 120);
  return output;
}
function validateCollectionPayload(collection, payload) {
  if (collection === 'events') {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(payload.eventDate || '') ? new Date(`${payload.eventDate}T00:00:00Z`) : null;
    if (!date || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== payload.eventDate) {
      throw new Error('A valid event date is required.');
    }
  }
  if (collection === 'youtubeVideos') {
    const videoId = extractYouTubeVideoId(payload.videoUrl || '');
    if (!videoId) throw new Error('Enter a valid YouTube video URL.');
    payload.videoId = videoId;
    if (!payload.image) payload.image = `/assets/images/video-thumbnails/${videoId}.jpg`;
  }
  return payload;
}
function validatePagesDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A valid pages document is required.');
  const payload = {};
  for (const key of Object.keys(defaults.pages)) {
    const page = input[key];
    if (!page || typeof page !== 'object' || Array.isArray(page)) throw new Error(`${key} page content is required.`);
    if (typeof page.published !== 'boolean') throw new Error(`${key} page visibility must be true or false.`);
    if (!Array.isArray(page.sections) || page.sections.length > 30) throw new Error(`${key} page must have at most 30 sections.`);
    payload[key] = {
      title: requiredText(page.title, `${key} page title`, 120),
      description: optionalText(page.description, `${key} page description`, 3000),
      image: optionalText(page.image, `${key} page image`, 1000),
      published: page.published,
      sections: page.sections.map((section) => {
        if (!section || typeof section !== 'object' || Array.isArray(section)) throw new Error(`${key} page sections must be valid objects.`);
        if (typeof section.published !== 'boolean') throw new Error(`${key} section visibility must be true or false.`);
        if (!Array.isArray(section.bullets) || section.bullets.length > 30) throw new Error(`${key} section lists must have at most 30 items.`);
        return {
          heading: requiredText(section.heading, 'Section heading', 120),
          body: optionalText(section.body, 'Section description', 3000),
          image: optionalText(section.image, 'Section image', 1000),
          bullets: section.bullets.map((item) => requiredText(item, 'Section list item', 500)),
          published: section.published
        };
      })
    };
  }
  return payload;
}
function validateNavigationDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.items) || input.items.length > 40) {
    throw new Error('Navigation must contain a list of at most 40 menu items.');
  }
  const ids = new Set();
  const items = input.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each navigation item must be a valid object.');
    const menuId = requiredText(item.id, 'Menu item ID', 48);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(menuId) || ids.has(menuId)) throw new Error('Menu item IDs must be unique lowercase words separated by hyphens.');
    ids.add(menuId);
    const href = requiredText(item.href, 'Menu link', 1000);
    if (/[\u0000-\u001f\\]/.test(href) || href.startsWith('//')) throw new Error('Menu links must use a safe website path or HTTPS URL.');
    if (!href.startsWith('/') && !/^#[a-zA-Z0-9_-]+$/.test(href)) {
      let parsed;
      try { parsed = new URL(href); }
      catch { throw new Error('Menu links must use a safe website path or HTTPS URL.'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('External menu links must use HTTPS.');
    }
    const parentId = item.parentId == null ? '' : optionalText(item.parentId, 'Menu parent ID', 48);
    if (parentId && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parentId)) throw new Error('Menu parent IDs must use lowercase words separated by hyphens.');
    if (!Number.isInteger(item.displayOrder) || item.displayOrder < 0 || item.displayOrder > 10000) throw new Error('Menu order must be a whole number between 0 and 10000.');
    for (const field of ['visible', 'prominent', 'newTab']) {
      if (typeof item[field] !== 'boolean') throw new Error(`${field} must be true or false.`);
    }
    if (parentId && item.prominent) throw new Error('A submenu item cannot be a prominent admissions button.');
    return {
      id: menuId,
      label: requiredText(item.label, 'Menu label', 80),
      href,
      parentId,
      displayOrder: item.displayOrder,
      visible: item.visible,
      prominent: item.prominent,
      newTab: item.newTab
    };
  });
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (item.prominent && items.some((child) => child.parentId === item.id)) throw new Error('A prominent admissions button cannot contain submenu items.');
    if (!item.parentId) continue;
    const parent = byId.get(item.parentId);
    if (!parent || parent.parentId) throw new Error('Each submenu must belong to an existing top-level menu item.');
  }
  return { items };
}
function handleValidation(fn) {
  return (req, res, next) => {
    try { fn(req, res, next); }
    catch (error) { res.status(400).json({ error: error.message }); }
  };
}

app.get('/api/public/content', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const documents = Object.fromEntries(db.prepare('SELECT key,payload FROM site_documents').all().map(({ key, payload }) => [key, JSON.parse(payload)]));
  const collections = {};
  for (const collection of allowedCollections) {
    collections[collection] = db.prepare("SELECT id,payload,created_at,updated_at FROM content_items WHERE collection=? ORDER BY json_extract(payload,'$.displayOrder'), created_at")
      .all(collection).map((item) => ({ id: item.id, ...JSON.parse(item.payload), createdAt: item.created_at, updatedAt: item.updated_at }))
      .filter((item) => item.published && (collection !== 'testimonials' || item.approved));
  }

  // Inject dynamic CMS sections, active marquees, and section images
  const cmsSections = db.prepare("SELECT * FROM cms_sections WHERE status = 'published' ORDER BY display_order ASC").all();
  const cmsBlocks = db.prepare("SELECT * FROM cms_content_blocks WHERE status = 'published'").all();
  const cmsImages = db.prepare("SELECT * FROM cms_section_images WHERE status = 'published' ORDER BY display_order ASC").all();
  const nowIso = new Date().toISOString();
  const cmsMarquees = db.prepare(`
    SELECT * FROM cms_marquees
    WHERE is_active = 1
      AND (start_date IS NULL OR start_date <= ?)
      AND (expiry_date IS NULL OR expiry_date >= ?)
    ORDER BY display_order ASC
  `).all(nowIso, nowIso);

  const dynamicCms = {
    sections: cmsSections.map(sec => ({
      ...sec,
      blocks: Object.fromEntries(cmsBlocks.filter(b => b.section_id === sec.id).map(b => [b.block_key, b.published_value])),
      images: cmsImages.filter(img => img.section_id === sec.id),
      marquees: cmsMarquees.filter(m => m.section_id === sec.id)
    })),
    activeMarquees: cmsMarquees
  };

  res.json({ documents, collections, dynamicCms });
});
app.post('/api/public/enquiries', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (body.website) return res.status(201).json({ ok: true });
    const isContact = body.kind === 'contact';
    const isParent = body.kind === 'parent';
    const requiresStudentDetails = !isContact && !isParent;
    const record = {
      parent: requiredText(body.parentName, 'Parent name', 120),
      student: requiresStudentDetails ? requiredText(body.studentName, 'Student name', 120) : '—',
      mobile: requiresStudentDetails ? requiredText(body.mobile, 'Mobile number', 20) : '—',
      email: requiredText(body.email, 'Email', 254).toLowerCase(),
      grade: isContact ? 'General Contact' : isParent ? 'Parent Enquiry' : requiredText(body.applyingClass, 'Applying class', 80),
      year: isContact || isParent ? 'General' : requiredText(body.academicYear || '2026–27', 'Academic year', 20),
      previousSchool: requiresStudentDetails ? optionalText(body.previousSchool, 'Previous school', 120) : '',
      message: isParent ? requiredText(body.message, 'Message', 2000) : optionalText(body.message, 'Message', 2000)
    };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email) || (requiresStudentDetails && !/^[+0-9 ()-]{10,20}$/.test(record.mobile))) {
      return res.status(400).json({ error: 'Enter a valid email address and mobile number.' });
    }
    const timestamp = now();
    db.prepare(`INSERT INTO enquiries(id,parent_name,student_name,mobile,email,applying_class,academic_year,previous_school,message,type,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id(), record.parent, record.student, record.mobile, record.email, record.grade, record.year, record.previousSchool, record.message, isContact ? 'Contact' : isParent ? 'Parent' : 'Admission', timestamp, timestamp);
    res.status(201).json({ ok: true, message: isContact ? 'Your message has been received.' : isParent ? 'Your parent enquiry has been received.' : 'Your enquiry has been received.' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/auth/login', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const admin = db.prepare('SELECT * FROM admins WHERE email=?').get(email);
  if (!admin || password.length > 200 || !passwordMatches(password, admin.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
  db.prepare('INSERT INTO sessions(id_hash,admin_id,csrf_token,expires_at) VALUES(?,?,?,?)')
    .run(hashToken(rawToken), admin.id, csrfToken, Date.now() + 8 * 60 * 60 * 1000);
  res.cookie('enpee_session', rawToken, cookieOptions(8 * 60 * 60 * 1000));
  logAction(admin, 'Signed in', 'Admin account');
  res.json({ csrfToken, email: admin.email, role: admin.role });
});
app.post('/api/auth/forgot', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const admin = db.prepare('SELECT id,email FROM admins WHERE email=?').get(email);
  const generic = { message: 'If that administrator account exists, password reset instructions will be emailed.' };
  if (!admin || !process.env.SMTP_HOST || !process.env.SMTP_FROM) return res.json(generic);
  const raw = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM password_resets WHERE admin_id=?').run(admin.id);
  db.prepare('INSERT INTO password_resets(token_hash,admin_id,expires_at) VALUES(?,?,?)')
    .run(hashToken(raw), admin.id, Date.now() + 30 * 60 * 1000);
  const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: (process.env.SMTP_PASSWORD || process.env.SMTP_PASS) } : undefined
  });
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM, to: admin.email, subject: 'ENPEE CMS password reset',
      text: `Use this link within 30 minutes to reset your ENPEE CMS password:\n${origin}/admin/reset?token=${raw}`
    });
  } catch (error) {
    db.prepare('DELETE FROM password_resets WHERE admin_id=?').run(admin.id);
    console.error('Password reset email failed:', error.message);
    return res.status(503).json({ error: 'Password reset email could not be sent. Please contact the system administrator.' });
  }
  res.json(generic);
});
app.post('/api/auth/reset', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const token = typeof body.token === 'string' ? body.token : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 14 || password.length > 200) return res.status(400).json({ error: 'Password must be between 14 and 200 characters.' });
  const reset = db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND expires_at>?').get(hashToken(token), Date.now());
  if (!reset) return res.status(400).json({ error: 'This reset link is invalid or expired.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
  db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(passwordHash, reset.admin_id);
  db.prepare('DELETE FROM password_resets WHERE admin_id=?').run(reset.admin_id);
  db.prepare('DELETE FROM sessions WHERE admin_id=?').run(reset.admin_id);
  res.json({ message: 'Password updated. You can now sign in.' });
});
app.post('/api/auth/password', privateApi, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  const admin = db.prepare('SELECT password_hash FROM admins WHERE id=?').get(req.admin.id);
  if (currentPassword.length > 200 || !passwordMatches(currentPassword, admin.password_hash)) return res.status(401).json({ error: 'Current password is incorrect.' });
  if (newPassword.length < 14 || newPassword.length > 200) return res.status(400).json({ error: 'New password must be between 14 and 200 characters.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = `${salt}:${crypto.scryptSync(newPassword, salt, 64).toString('hex')}`;
  db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(passwordHash, req.admin.id);
  db.prepare('DELETE FROM sessions WHERE admin_id=? AND id_hash<>?').run(req.admin.id, hashToken(req.cookies.enpee_session));
  logAction(req.admin, 'Changed password', 'Admin account');
  res.json({ ok: true });
});
app.get('/api/auth/me', privateApi, (req, res) => res.json({ email: req.admin.email, role: req.admin.role, csrfToken: req.csrfToken }));
app.post('/api/auth/logout', privateApi, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id_hash=?').run(hashToken(req.cookies.enpee_session));
  res.clearCookie('enpee_session', cookieOptions(0));
  logAction(req.admin, 'Signed out', 'Admin account');
  res.json({ ok: true });
});

app.get('/api/admin/dashboard', privateApi, (_req, res) => {
  let missingImagesCount = 0;
  try {
    const allReqs = db.prepare('SELECT section_id, slot_key FROM cms_image_requirements').all();
    for (const r of allReqs) {
      const has = db.prepare('SELECT id FROM cms_section_images WHERE section_id=? AND slot_key=?').get(r.section_id, r.slot_key);
      if (!has) missingImagesCount++;
    }
  } catch { }

  const counts = {
    enquiries: db.prepare('SELECT COUNT(*) AS count FROM enquiries').get().count,
    newEnquiries: db.prepare("SELECT COUNT(*) AS count FROM enquiries WHERE status='New' AND type='Admission'").get().count,
    programs: db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE collection='programs'").get().count,
    gallery: db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE collection='gallery'").get().count + db.prepare('SELECT COUNT(*) AS count FROM media').get().count,
    announcements: (db.prepare("SELECT COUNT(*) AS count FROM cms_marquees").get()?.count) || db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE collection='announcements'").get().count,
    sections: db.prepare('SELECT COUNT(*) AS count FROM cms_sections').get()?.count || 18,
    missingImages: missingImagesCount
  };
  const recentEnquiries = db.prepare('SELECT * FROM enquiries ORDER BY created_at DESC LIMIT 8').all();
  const activities = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 8').all();
  const enquiryChart = db.prepare(`SELECT substr(created_at,1,7) AS month, COUNT(*) AS count FROM enquiries
    WHERE created_at>=datetime('now','-6 months') GROUP BY month ORDER BY month`).all();
  res.json({ counts, recentEnquiries, activities, enquiryChart });
});



app.get('/api/admin/documents/:key', privateApi, (req, res) => {
  if (!['sections', 'home', 'about', 'contact', 'pages', 'navigation'].includes(req.params.key)) return res.status(404).json({ error: 'Document not found.' });
  const row = db.prepare('SELECT payload,updated_at FROM site_documents WHERE key=?').get(req.params.key);
  if (!row) return res.status(404).json({ error: 'Document not found.' });
  res.json({ ...JSON.parse(row.payload), updatedAt: row.updated_at });
});
app.put('/api/admin/documents/:key', privateApi, handleValidation((req, res) => {
  const key = req.params.key;
  if (!['sections', 'home', 'about', 'contact', 'pages', 'navigation'].includes(key)) return res.status(404).json({ error: 'Document not found.' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || JSON.stringify(req.body).length > 50000) {
    return res.status(400).json({ error: 'A valid document under 50 KB is required.' });
  }
  if (key === 'pages') {
    const payload = validatePagesDocument(req.body);
    const timestamp = now();
    db.prepare('UPDATE site_documents SET payload=?,updated_at=? WHERE key=?').run(JSON.stringify(payload), timestamp, key);
    logAction(req.admin, 'Updated', 'Public page content');
    res.json({ ...payload, updatedAt: timestamp });
    return;
  }
  if (key === 'navigation') {
    const payload = validateNavigationDocument(req.body);
    const timestamp = now();
    db.prepare('UPDATE site_documents SET payload=?,updated_at=? WHERE key=?').run(JSON.stringify(payload), timestamp, key);
    logAction(req.admin, 'Updated', 'Website navigation');
    res.json({ ...payload, updatedAt: timestamp });
    return;
  }
  const payload = {};
  const fields = key === 'sections' ? Object.keys(defaults.sections)
    : key === 'home'
      ? ['heroHeading', 'heroDescription', 'heroImage', 'logoImage', 'marqueeEnabled', 'academicYear', 'heroPrimaryText', 'heroPrimaryLink', 'heroSecondaryText', 'heroSecondaryLink', 'welcomeHeading', 'welcomeText', 'statistics', 'highlights']
      : key === 'about' ? ['introduction', 'vision', 'mission', 'values', 'achievements', 'history', 'philosophy', 'learningEnvironment', 'infrastructure', 'chateauDescription', 'chateauImage', 'chateauPublished', 'wayWeWork', 'wayWeWorkPublished', 'parentsCornerMessage', 'parentsCornerImage', 'parentsCornerPublished', 'photos']
        : Object.keys(defaults.contact);
  for (const field of fields) {
    const value = req.body[field];
    if (booleanDocumentFields.has(field)) {
      if (typeof value !== 'boolean') return res.status(400).json({ error: `${field} must be true or false.` });
      payload[field] = value;
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 50 || value.some((entry) => typeof entry !== 'string' && (typeof entry !== 'object' || entry === null))) {
        return res.status(400).json({ error: `${field} must be a list of strings or objects (maximum 50).` });
      }
      payload[field] = value;
    } else {
      if (typeof value !== 'string' || value.length > 5000) return res.status(400).json({ error: `${field} must be text no longer than 5000 characters.` });
      payload[field] = value.trim();
    }
  }
  const timestamp = now();
  const save = db.transaction(() => {
    db.prepare('UPDATE site_documents SET payload=?,updated_at=? WHERE key=?').run(JSON.stringify(payload), timestamp, key);
    if (key === 'home') {
      const about = JSON.parse(db.prepare('SELECT payload FROM site_documents WHERE key=?').get('about').payload);
      about.introduction = payload.welcomeText;
      db.prepare('UPDATE site_documents SET payload=?,updated_at=? WHERE key=?').run(JSON.stringify(about), timestamp, 'about');
    } else if (key === 'about') {
      const home = JSON.parse(db.prepare('SELECT payload FROM site_documents WHERE key=?').get('home').payload);
      home.welcomeText = payload.introduction;
      db.prepare('UPDATE site_documents SET payload=?,updated_at=? WHERE key=?').run(JSON.stringify(home), timestamp, 'home');
    }
  });
  save();
  logAction(req.admin, 'Updated', `${key} content`);
  res.json({ ...payload, updatedAt: timestamp });
}));

app.get('/api/admin/collections/:collection', privateApi, (req, res) => {
  const { collection } = req.params;
  if (!allowedCollections.has(collection)) return res.status(404).json({ error: 'Collection not found.' });
  if (collection === 'announcements') {
    const marquees = db.prepare('SELECT * FROM cms_marquees ORDER BY display_order ASC, created_at DESC').all();
    const items = marquees.map(m => ({
      id: m.id,
      title: m.text,
      text: m.text,
      active: m.is_active === 1,
      speed: m.speed_seconds || 20,
      createdAt: m.created_at,
      updatedAt: m.updated_at
    }));
    return res.json({ items, total: items.length, page: 1, pages: 1 });
  }
  const rows = db.prepare("SELECT id,payload,created_at,updated_at FROM content_items WHERE collection=? ORDER BY json_extract(payload,'$.displayOrder'),created_at DESC")
    .all(collection).map((row) => ({ id: row.id, ...JSON.parse(row.payload), createdAt: row.created_at, updatedAt: row.updated_at }));
  const query = String(req.query.q || '').toLowerCase();
  const filtered = query ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query)) : rows;
  const page = positiveInt(req.query.page, 1, 1000000);
  const limit = positiveInt(req.query.limit, 25, 100);
  res.json({ items: filtered.slice((page - 1) * limit, page * limit), total: filtered.length, page, pages: Math.max(1, Math.ceil(filtered.length / limit)) });
});
app.post('/api/admin/collections/:collection', privateApi, handleValidation((req, res) => {
  const { collection } = req.params;
  if (!allowedCollections.has(collection)) return res.status(404).json({ error: 'Collection not found.' });
  if (collection === 'announcements') {
    const text = req.body.text || req.body.title || 'Announcement';
    const active = req.body.active !== false ? 1 : 0;
    const speed = Number(req.body.speed) || 20;
    const recordId = id();
    const timestamp = now();
    db.prepare('INSERT INTO cms_marquees(id, section_id, text, link_url, direction, speed_seconds, bg_color, text_color, font_size_px, font_weight, display_order, is_active, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      recordId, req.body.sectionId || 'notice_marquee', text, '', 'ltr', speed, '#1E61AC', '#FFFFFF', 14, '600', 0, active, timestamp, timestamp
    );
    try {
      db.prepare('INSERT INTO content_items(id,collection,payload,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(recordId, 'announcements', JSON.stringify({ title: text, text, active: active === 1, speed }), timestamp, timestamp);
    } catch { }
    logAction(req.admin, 'Created', 'Announcement: ' + text);
    return res.status(201).json({ id: recordId, text, title: text, active: active === 1, speed, createdAt: timestamp, updatedAt: timestamp });
  }
  const payload = validateCollectionPayload(collection, cleanPayload(req.body));
  if (collection === 'testimonials' && !Object.hasOwn(req.body, 'approved')) payload.approved = false;
  const timestamp = now();
  const recordId = id();
  db.prepare('INSERT INTO content_items(id,collection,payload,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(recordId, collection, JSON.stringify(payload), timestamp, timestamp);
  logAction(req.admin, 'Created', `${collection}: ${payload.title}`);
  res.status(201).json({ id: recordId, ...payload, createdAt: timestamp, updatedAt: timestamp });
}));
app.put('/api/admin/collections/:collection/:id', privateApi, handleValidation((req, res) => {
  const { collection, id: recordId } = req.params;
  if (!allowedCollections.has(collection)) return res.status(404).json({ error: 'Collection not found.' });
  if (collection === 'announcements') {
    const existing = db.prepare('SELECT * FROM cms_marquees WHERE id=?').get(recordId);
    const text = req.body.text !== undefined ? req.body.text : (req.body.title !== undefined ? req.body.title : (existing?.text || ''));
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : (existing?.is_active ?? 1);
    const speed = req.body.speed !== undefined ? Number(req.body.speed) : (existing?.speed_seconds || 20);
    const timestamp = now();
    if (existing) {
      db.prepare('UPDATE cms_marquees SET text=?, is_active=?, speed_seconds=?, updated_at=? WHERE id=?')
        .run(text, active, speed, timestamp, recordId);
    } else {
      db.prepare('INSERT INTO cms_marquees(id, section_id, text, link_url, direction, speed_seconds, bg_color, text_color, font_size_px, font_weight, display_order, is_active, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        recordId, 'notice_marquee', text, '', 'ltr', speed, '#1E61AC', '#FFFFFF', 14, '600', 0, active, timestamp, timestamp
      );
    }
    try {
      db.prepare("UPDATE content_items SET payload=?, updated_at=? WHERE collection='announcements' AND id=?")
        .run(JSON.stringify({ title: text, text, active: active === 1, speed }), timestamp, recordId);
    } catch { }
    logAction(req.admin, 'Updated', 'Announcement: ' + text);
    return res.json({ id: recordId, text, title: text, active: active === 1, speed });
  }
  const existing = db.prepare('SELECT id FROM content_items WHERE collection=? AND id=?').get(collection, recordId);
  if (!existing) return res.status(404).json({ error: 'Content item not found.' });
  const payload = validateCollectionPayload(collection, cleanPayload(req.body));
  db.prepare('UPDATE content_items SET payload=?,updated_at=? WHERE collection=? AND id=?').run(JSON.stringify(payload), now(), collection, recordId);
  logAction(req.admin, 'Updated', `${collection}: ${payload.title}`);
  res.json({ id: recordId, ...payload });
}));
app.delete('/api/admin/collections/:collection/:id', privateApi, (req, res) => {
  const { collection, id: recordId } = req.params;
  if (!allowedCollections.has(collection)) return res.status(404).json({ error: 'Collection not found.' });
  if (collection === 'announcements') {
    db.prepare('DELETE FROM cms_marquees WHERE id=?').run(recordId);
    try { db.prepare("DELETE FROM content_items WHERE collection='announcements' AND id=?").run(recordId); } catch { }
    logAction(req.admin, 'Deleted', 'Announcement: ' + recordId);
    return res.json({ ok: true });
  }
  const row = db.prepare('SELECT payload FROM content_items WHERE collection=? AND id=?').get(collection, recordId);
  if (!row) return res.status(404).json({ error: 'Content item not found.' });
  db.prepare('DELETE FROM content_items WHERE collection=? AND id=?').run(collection, recordId);
  logAction(req.admin, 'Deleted', `${collection}: ${JSON.parse(row.payload).title}`);
  res.json({ ok: true });
});

app.get('/api/admin/enquiries', privateApi, (req, res) => {
  const page = positiveInt(req.query.page, 1, 1000000);
  const limit = positiveInt(req.query.limit, 25, 100);
  const filters = [];
  const values = [];
  if (req.query.status && ['New', 'Contacted', 'In Progress', 'Completed'].includes(req.query.status)) { filters.push('status=?'); values.push(req.query.status); }
  if (req.query.class) { filters.push('applying_class=?'); values.push(String(req.query.class).slice(0, 80)); }
  if (req.query.from) { filters.push('created_at>=?'); values.push(`${String(req.query.from).slice(0, 10)}T00:00:00.000Z`); }
  if (req.query.to) { filters.push('created_at<=?'); values.push(`${String(req.query.to).slice(0, 10)}T23:59:59.999Z`); }
  if (req.query.q) { filters.push('(parent_name LIKE ? OR student_name LIKE ? OR email LIKE ? OR mobile LIKE ?)'); const term = `%${String(req.query.q).slice(0, 80)}%`; values.push(term, term, term, term); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS count FROM enquiries ${where}`).get(...values).count;
  const items = db.prepare(`SELECT * FROM enquiries ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...values, limit, (page - 1) * limit);
  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});
app.patch('/api/admin/enquiries/:id', privateApi, (req, res) => {
  const { status, internalNotes } = req.body || {};
  if (status !== undefined && !['New', 'Contacted', 'In Progress', 'Completed'].includes(status)) return res.status(400).json({ error: 'Invalid enquiry status.' });
  if (internalNotes !== undefined && (typeof internalNotes !== 'string' || internalNotes.length > 5000)) return res.status(400).json({ error: 'Internal notes must be under 5000 characters.' });
  const fields = [];
  const values = [];
  if (status !== undefined) { fields.push('status=?'); values.push(status); }
  if (internalNotes !== undefined) { fields.push('internal_notes=?'); values.push(internalNotes.trim()); }
  if (!fields.length) return res.status(400).json({ error: 'No valid updates were provided.' });
  fields.push('updated_at=?'); values.push(now(), req.params.id);
  const result = db.prepare(`UPDATE enquiries SET ${fields.join(',')} WHERE id=?`).run(...values);
  if (!result.changes) return res.status(404).json({ error: 'Enquiry not found.' });
  logAction(req.admin, 'Updated', `Admission enquiry ${req.params.id}`);
  res.json({ ok: true });
});
app.delete('/api/admin/enquiries/:id', privateApi, (req, res) => {
  const result = db.prepare('DELETE FROM enquiries WHERE id=?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Enquiry not found.' });
  logAction(req.admin, 'Deleted', `Admission enquiry ${req.params.id}`);
  res.json({ ok: true });
});
app.get('/api/admin/enquiries.csv', privateApi, (req, res) => {
  const rows = db.prepare('SELECT parent_name,student_name,mobile,email,applying_class,academic_year,previous_school,message,status,internal_notes,created_at FROM enquiries ORDER BY created_at DESC').all();
  const escape = (value) => {
    let text = String(value ?? '');
    if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const csv = ['Parent,Student,Mobile,Email,Class,Academic year,Previous school,Message,Status,Internal notes,Submitted at', ...rows.map((row) => Object.values(row).map(escape).join(','))].join('\r\n');
  res.type('text/csv').attachment('enpee-enquiries.csv').send(csv);
});
app.get('/api/admin/enquiries/:id', privateApi, (req, res) => {
  const item = db.prepare('SELECT * FROM enquiries WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Enquiry not found.' });
  res.json(item);
});

const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'application/pdf'];
    const supported = allowed.includes(file.mimetype);
    const error = supported ? null : Object.assign(new Error('Only JPEG, PNG, WebP, AVIF, MP4, WebM and PDF files are supported.'), { status: 400 });
    callback(error, supported);
  }
});
const mediaUploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 50, standardHeaders: 'draft-8', legacyHeaders: false, handler: limitResponse });
app.use('/api/admin/media', (req, res, next) => (req.method === 'POST' ? mediaUploadLimiter(req, res, next) : next()));
app.get('/api/admin/media', privateApi, (req, res) => {
  const query = `%${String(req.query.q || '').slice(0, 80)}%`;
  const items = db.prepare('SELECT * FROM media WHERE original_name LIKE ? OR category LIKE ? ORDER BY created_at DESC LIMIT 300').all(query, query);
  res.json(items.map((item) => ({
    ...item,
    url: item.filename.startsWith('assets/') ? `/${item.filename}` : `/uploads/${item.filename}`
  })));
});
async function processMediaFile(file, targetMime = null) {
  let buffer = file.buffer;
  let mimeType = file.mimetype;
  try {
    if (mimeType === 'application/pdf') {
      if (buffer.length < 5 || buffer.toString('ascii', 0, 4) !== '%PDF') {
        throw new Error('The uploaded file is not a valid PDF document.');
      }
      return { buffer, mimeType: 'application/pdf' };
    }
    if (mimeType.startsWith('image/')) {
      const image = sharp(buffer, { limitInputPixels: 40000000 });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || metadata.width > 10000 || metadata.height > 10000) throw new Error('Image dimensions are too large or invalid.');
      const desiredMime = targetMime || 'image/webp';
      if (desiredMime === 'image/jpeg' || desiredMime === 'image/jpg') {
        buffer = await image.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        mimeType = 'image/jpeg';
      } else if (desiredMime === 'image/png') {
        buffer = await image.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 8 }).toBuffer();
        mimeType = 'image/png';
      } else {
        buffer = await image.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, effort: 5 }).toBuffer();
        mimeType = 'image/webp';
      }
    } else {
      const validMp4 = mimeType === 'video/mp4' && buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
      const validWebm = mimeType === 'video/webm' && buffer.length > 4 &&
        buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
      if (!validMp4 && !validWebm) throw new Error('The uploaded video does not match its file type.');
    }
  } catch (error) {
    const message = error instanceof Error && error.message.includes('Input file')
      ? 'The uploaded file is invalid or unsupported.'
      : error.message;
    throw Object.assign(new Error(message), { status: 400 });
  }
  return { buffer, mimeType };
}
app.post('/api/admin/media', privateApi, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a media file to upload.' });
  const category = optionalText(req.body.category || 'General', 'category', 80) || 'General';
  // Sharp dimension check if image has section requirement
  if (req.file.mimetype.startsWith('image/') && category.startsWith('Section: ')) {
    const sectionId = category.replace('Section: ', '').trim();
    try {
      const slotKey = req.body.slotKey || req.body.slot_key;
      const reqRow = slotKey
        ? db.prepare('SELECT * FROM cms_image_requirements WHERE section_id=? AND slot_key=?').get(sectionId, slotKey)
        : db.prepare('SELECT * FROM cms_image_requirements WHERE section_id=?').get(sectionId);
      if (reqRow) {
        const val = await validateImageRequirement(req.file.buffer, reqRow);
        if (!val.valid) {
          return res.status(400).json({ error: val.error, validation: val });
        }
      }
    } catch (err) {
      if (err.status === 400 || err.message.includes('Image')) {
        return res.status(400).json({ error: err.message });
      }
    }
  }

  const processed = await processMediaFile(req.file);
  const ext = processed.mimeType === 'image/webp' ? '.webp' : processed.mimeType === 'video/mp4' ? '.mp4' : processed.mimeType === 'application/pdf' ? '.pdf' : '.webm';
  const filename = `${crypto.randomUUID()}${ext}`;
  const destination = path.join(uploadDir, filename);
  const recordId = id();
  fs.writeFileSync(destination, processed.buffer, { flag: 'wx' });
  try {
    const save = db.transaction(() => {
      db.prepare('INSERT INTO media(id,filename,original_name,mime_type,size,category,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(recordId, filename, req.file.originalname.slice(0, 200), processed.mimeType, processed.buffer.length, category, now());
      logAction(req.admin, 'Uploaded', `Media: ${req.file.originalname.slice(0, 80)}`);
    });
    save();
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
  res.status(201).json({ id: recordId, filename, url: `/uploads/${filename}`, mime_type: processed.mimeType, size: processed.buffer.length, category });
});
app.post('/api/admin/media/:id/replace', privateApi, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a replacement file.' });
  const item = db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Media item not found.' });
  const processed = await processMediaFile(req.file, item.mime_type);
  if (processed.mimeType !== item.mime_type) return res.status(400).json({ error: 'The replacement must use the same media type so existing website references remain valid.' });
  const isUpload = !item.filename.startsWith('assets/');
  const targetPath = isUpload ? path.join(uploadDir, item.filename) : path.join(root, item.filename);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, processed.buffer);
  if (!isUpload && fs.existsSync(path.join(root, 'dist'))) {
    const distTarget = path.join(root, 'dist', item.filename);
    try {
      fs.mkdirSync(path.dirname(distTarget), { recursive: true });
      fs.writeFileSync(distTarget, processed.buffer);
    } catch (e) {
      console.warn('Could not mirror replacement to dist:', e.message);
    }
  }
  db.prepare('UPDATE media SET original_name=?,size=? WHERE id=?')
    .run(req.file.originalname.slice(0, 200), processed.buffer.length, item.id);
  logAction(req.admin, 'Replaced', `Media: ${item.original_name}`);
  const url = isUpload ? `/uploads/${item.filename}` : `/${item.filename}`;
  res.json({ id: item.id, filename: item.filename, url, mime_type: item.mime_type, size: processed.buffer.length, category: item.category });
});
app.delete('/api/admin/media/:id', privateApi, (req, res) => {
  const item = db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Media item not found.' });
  const isUpload = !item.filename.startsWith('assets/');
  const targetUrl = isUpload ? `/uploads/${item.filename}` : `/${item.filename}`;
  const relativeTarget = item.filename;

  const references = db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE payload LIKE ? OR payload LIKE ?").get(`%${targetUrl}%`, `%${relativeTarget}%`).count;
  const documentReferences = db.prepare("SELECT COUNT(*) AS count FROM site_documents WHERE payload LIKE ? OR payload LIKE ?").get(`%${targetUrl}%`, `%${relativeTarget}%`).count;
  if ((references || documentReferences) && req.query.force !== 'true') {
    return res.status(409).json({ error: 'This file is referenced by website content. Replace or remove those references first.' });
  }

  if (req.query.force === 'true' && (references || documentReferences)) {
    const clearRefs = db.transaction(() => {
      const rows = db.prepare("SELECT id, payload FROM content_items WHERE payload LIKE ? OR payload LIKE ?").all(`%${targetUrl}%`, `%${relativeTarget}%`);
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.payload);
          let changed = false;
          for (const key of Object.keys(parsed)) {
            if (typeof parsed[key] === 'string' && (parsed[key] === targetUrl || parsed[key] === relativeTarget || parsed[key].endsWith(item.filename))) {
              parsed[key] = '';
              changed = true;
            } else if (Array.isArray(parsed[key])) {
              const prev = JSON.stringify(parsed[key]);
              parsed[key] = parsed[key].filter((v) => typeof v !== 'string' || (!v.includes(targetUrl) && !v.includes(relativeTarget) && !v.endsWith(item.filename)));
              if (JSON.stringify(parsed[key]) !== prev) changed = true;
            }
          }
          if (changed) {
            db.prepare('UPDATE content_items SET payload=? WHERE id=?').run(JSON.stringify(parsed), row.id);
          }
        } catch {
          const replaced = row.payload.replaceAll(targetUrl, '').replaceAll(relativeTarget, '');
          db.prepare('UPDATE content_items SET payload=? WHERE id=?').run(replaced, row.id);
        }
      }

      const docs = db.prepare("SELECT key, payload FROM site_documents WHERE payload LIKE ? OR payload LIKE ?").all(`%${targetUrl}%`, `%${relativeTarget}%`);
      for (const doc of docs) {
        try {
          const parsed = JSON.parse(doc.payload);
          let changed = false;
          for (const key of Object.keys(parsed)) {
            if (typeof parsed[key] === 'string' && (parsed[key] === targetUrl || parsed[key] === relativeTarget || parsed[key].endsWith(item.filename))) {
              parsed[key] = '';
              changed = true;
            } else if (Array.isArray(parsed[key])) {
              const prev = JSON.stringify(parsed[key]);
              parsed[key] = parsed[key].map((v) => (typeof v === 'string' && (v === targetUrl || v === relativeTarget || v.endsWith(item.filename))) ? '' : v);
              if (JSON.stringify(parsed[key]) !== prev) changed = true;
            }
          }
          if (changed) {
            db.prepare('UPDATE site_documents SET payload=? WHERE key=?').run(JSON.stringify(parsed), doc.key);
          }
        } catch {
          const replaced = doc.payload.replaceAll(targetUrl, '').replaceAll(relativeTarget, '');
          db.prepare('UPDATE site_documents SET payload=? WHERE key=?').run(replaced, doc.key);
        }
      }
    });
    clearRefs();
  }

  db.prepare('DELETE FROM media WHERE id=?').run(item.id);
  const filePath = isUpload ? path.join(uploadDir, item.filename) : path.join(root, item.filename);
  fs.rmSync(filePath, { force: true });
  if (!isUpload && fs.existsSync(path.join(root, 'dist', item.filename))) {
    fs.rmSync(path.join(root, 'dist', item.filename), { force: true });
  }
  logAction(req.admin, 'Deleted', `Media: ${item.original_name}`);
  res.json({ ok: true });
});

/* ==========================================================================
   DYNAMIC SECTION-FIRST CMS API ENDPOINTS
   ========================================================================== */

// Helper to validate uploaded buffer against image requirements
async function validateImageRequirement(buffer, requirement) {
  if (!requirement) return { valid: true };
  try {
    const image = sharp(buffer, { limitInputPixels: 40000000 });
    const metadata = await image.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const format = (metadata.format || '').toLowerCase();
    const sizeKb = Math.round(buffer.length / 1024);
    const dpi = metadata.density || 72;

    const allowed = (requirement.allowed_formats || 'jpg,jpeg,png,webp,avif').toLowerCase().split(',').map(s => s.trim());
    const formatMatch = allowed.includes(format) || (format === 'jpeg' && allowed.includes('jpg'));
    if (!formatMatch) {
      return { valid: false, error: `Invalid image format: ${format.toUpperCase()}. Allowed formats: ${allowed.join(', ').toUpperCase()}.` };
    }

    if (requirement.max_size_kb && sizeKb > requirement.max_size_kb) {
      return { valid: false, error: `File size (${sizeKb} KB) exceeds maximum allowed size of ${requirement.max_size_kb} KB.` };
    }

    if (requirement.exact_width && width !== requirement.exact_width) {
      return { valid: false, error: `Image width (${width}px) must be exactly ${requirement.exact_width}px.` };
    }
    if (requirement.exact_height && height !== requirement.exact_height) {
      return { valid: false, error: `Image height (${height}px) must be exactly ${requirement.exact_height}px.` };
    }

    if (requirement.min_width && width < requirement.min_width) {
      return { valid: false, error: `Image width (${width}px) is below minimum required (${requirement.min_width}px).` };
    }
    if (requirement.max_width && width > requirement.max_width) {
      return { valid: false, error: `Image width (${width}px) exceeds maximum allowed (${requirement.max_width}px).` };
    }
    if (requirement.min_height && height < requirement.min_height) {
      return { valid: false, error: `Image height (${height}px) is below minimum required (${requirement.min_height}px).` };
    }
    if (requirement.max_height && height > requirement.max_height) {
      return { valid: false, error: `Image height (${height}px) exceeds maximum allowed (${requirement.max_height}px).` };
    }

    if (requirement.aspect_ratio) {
      const parts = requirement.aspect_ratio.split(':').map(Number);
      if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
        const targetRatio = parts[0] / parts[1];
        const actualRatio = width / height;
        const tolerance = requirement.aspect_ratio_tolerance || 0.05;
        if (Math.abs(actualRatio - targetRatio) > tolerance) {
          return {
            valid: false,
            error: `Image aspect ratio (${actualRatio.toFixed(2)}) does not match required ${requirement.aspect_ratio} (${targetRatio.toFixed(2)} ± ${tolerance}).`
          };
        }
      }
    }

    return {
      valid: true,
      metadata: { width, height, format, sizeKb, dpi, aspectRatio: (width / height).toFixed(2) }
    };
  } catch (err) {
    return { valid: false, error: `Failed to process image: ${err.message}` };
  }
}





// Master Homepage Image Manager - Audits every image slot across all sections
app.get('/api/admin/cms/all-images', privateApi, (_req, res) => {
  const sections = db.prepare('SELECT id, name, category, display_order FROM cms_sections ORDER BY display_order ASC, name ASC').all();
  const allSlots = [];

  for (const sec of sections) {
    const reqs = db.prepare('SELECT * FROM cms_image_requirements WHERE section_id = ? ORDER BY created_at ASC').all(sec.id);
    const uploadedImages = db.prepare('SELECT * FROM cms_section_images WHERE section_id = ? ORDER BY display_order ASC').all(sec.id);

    const uploadedMap = new Map();
    for (const img of uploadedImages) {
      if (!uploadedMap.has(img.slot_key)) uploadedMap.set(img.slot_key, []);
      uploadedMap.get(img.slot_key).push(img);
    }

    for (const reqItem of reqs) {
      const slotImages = uploadedMap.get(reqItem.slot_key) || [];
      const hasImage = slotImages.length > 0;
      const currentImage = hasImage ? slotImages[0] : null;

      allSlots.push({
        section_id: sec.id,
        section_name: sec.name,
        section_category: sec.category,
        slot_key: reqItem.slot_key,
        slot_label: reqItem.label,
        required: Boolean(reqItem.required),
        exact_width: reqItem.exact_width,
        exact_height: reqItem.exact_height,
        min_width: reqItem.min_width,
        max_width: reqItem.max_width,
        min_height: reqItem.min_height,
        max_height: reqItem.max_height,
        aspect_ratio: reqItem.aspect_ratio,
        allowed_formats: reqItem.allowed_formats,
        max_size_kb: reqItem.max_size_kb,
        help_text: reqItem.help_text,
        status: hasImage ? (currentImage.status || 'published') : 'missing',
        is_missing: !hasImage,
        current_image: currentImage ? {
          id: currentImage.id,
          media_url: currentImage.media_url,
          original_name: currentImage.original_name,
          width: currentImage.width,
          height: currentImage.height,
          file_size: currentImage.file_size,
          mime_type: currentImage.mime_type
        } : null,
        additional_images: slotImages.slice(1).map(img => ({
          id: img.id,
          media_url: img.media_url,
          original_name: img.original_name,
          width: img.width,
          height: img.height
        }))
      });
    }
  }

  const missingCount = allSlots.filter(s => s.is_missing).length;
  res.json({
    slots: allSlots,
    totalSlots: allSlots.length,
    missingCount,
    filledCount: allSlots.length - missingCount
  });
});

// 1. Overview & Summary metrics for Admin Dashboard
app.get('/api/admin/cms/overview', privateApi, (_req, res) => {
  const totalSections = db.prepare('SELECT COUNT(*) AS count FROM cms_sections').get().count;
  const totalImages = db.prepare('SELECT COUNT(*) AS count FROM cms_section_images').get().count;
  const totalBlocks = db.prepare('SELECT COUNT(*) AS count FROM cms_content_blocks').get().count;
  const totalMarquees = db.prepare('SELECT COUNT(*) AS count FROM cms_marquees').get().count;
  const totalEnquiries = db.prepare('SELECT COUNT(*) AS count FROM enquiries').get().count;

  const sections = db.prepare('SELECT * FROM cms_sections ORDER BY display_order ASC, name ASC').all();
  const recentActivities = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 10').all();
  const recentUpdates = db.prepare(`
    SELECT s.id, s.name, s.category, s.updated_at,
           (SELECT COUNT(*) FROM cms_content_blocks WHERE section_id = s.id) as block_count,
           (SELECT COUNT(*) FROM cms_section_images WHERE section_id = s.id) as image_count,
           (SELECT COUNT(*) FROM cms_marquees WHERE section_id = s.id) as marquee_count,
           (SELECT media_url FROM cms_section_images WHERE section_id = s.id ORDER BY display_order ASC LIMIT 1) as thumbnail
    FROM cms_sections s
    ORDER BY s.updated_at DESC
    LIMIT 6
  `).all();

  const sectionCards = sections.map(sec => {
    const blocks = db.prepare('SELECT status FROM cms_content_blocks WHERE section_id = ?').all(sec.id);
    const images = db.prepare('SELECT media_url, status FROM cms_section_images WHERE section_id = ? ORDER BY display_order ASC').all(sec.id);
    const marquees = db.prepare('SELECT is_active FROM cms_marquees WHERE section_id = ?').all(sec.id);

    const hasDraftContent = blocks.some(b => b.status === 'draft');
    const hasDraftImages = images.some(img => img.status === 'draft');

    return {
      ...sec,
      thumbnail: images[0]?.media_url || '',
      totalBlocks: blocks.length,
      totalImages: images.length,
      totalMarquees: marquees.length,
      contentStatus: hasDraftContent ? 'draft' : 'published',
      imageStatus: hasDraftImages ? 'draft' : (images.length > 0 ? 'published' : 'none'),
      activeMarquees: marquees.filter(m => m.is_active).length
    };
  });

  res.json({
    metrics: {
      totalSections,
      totalImages,
      totalBlocks,
      totalMarquees,
      totalEnquiries
    },
    sections: sectionCards,
    recentUpdates,
    recentActivities
  });
});

// 2. Get full details for a single section (all 3 tabs)
app.get('/api/admin/cms/sections/:id', privateApi, (req, res) => {
  const section = db.prepare('SELECT * FROM cms_sections WHERE id = ?').get(req.params.id);
  if (!section) return res.status(404).json({ error: 'Section not found.' });

  const blocks = db.prepare('SELECT * FROM cms_content_blocks WHERE section_id = ? ORDER BY display_order ASC, created_at ASC').all(section.id);
  const requirements = db.prepare('SELECT * FROM cms_image_requirements WHERE section_id = ? ORDER BY created_at ASC').all(section.id);
  const images = db.prepare('SELECT * FROM cms_section_images WHERE section_id = ? ORDER BY display_order ASC, created_at ASC').all(section.id);
  const marquees = db.prepare('SELECT * FROM cms_marquees WHERE section_id = ? ORDER BY display_order ASC, created_at ASC').all(section.id);
  const revisions = db.prepare('SELECT id, admin_email, change_type, created_at FROM cms_content_revisions WHERE section_id = ? ORDER BY created_at DESC LIMIT 15').all(section.id);

  res.json({
    section,
    blocks,
    requirements,
    images,
    marquees,
    revisions
  });
});

// 3. Save Section Content Changes (Draft / Publish)
app.put('/api/admin/cms/sections/:id/content', privateApi, handleValidation((req, res) => {
  const sectionId = req.params.id;
  const section = db.prepare('SELECT * FROM cms_sections WHERE id = ?').get(sectionId);
  if (!section) return res.status(404).json({ error: 'Section not found.' });

  const { blocks, publishNow, sectionStatus, sectionName, sectionDescription } = req.body;
  const timestamp = now();

  const tx = db.transaction(() => {
    if (sectionName || sectionDescription || sectionStatus) {
      db.prepare(`UPDATE cms_sections SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        status = COALESCE(?, status),
        updated_at = ?
        WHERE id = ?`).run(sectionName || null, sectionDescription || null, sectionStatus || null, timestamp, sectionId);
    }

    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (!b.id && b.block_key) {
          // create new block
          db.prepare(`INSERT INTO cms_content_blocks(id, section_id, block_key, label, content_type, draft_value, published_value, status, display_order, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            id(), sectionId, b.block_key, b.label || b.block_key, b.content_type || 'rich_text',
            b.draft_value ?? '', publishNow ? (b.draft_value ?? '') : (b.published_value ?? ''),
            publishNow ? 'published' : (b.status || 'draft'), b.display_order || 0, timestamp, timestamp
          );
        } else if (b.id) {
          const draftVal = b.draft_value !== undefined ? String(b.draft_value) : '';
          const pubVal = publishNow ? draftVal : (b.published_value !== undefined ? String(b.published_value) : draftVal);
          const blockStatus = publishNow ? 'published' : (b.status || 'draft');

          db.prepare(`UPDATE cms_content_blocks SET
            label = COALESCE(?, label),
            draft_value = ?,
            published_value = ?,
            status = ?,
            display_order = COALESCE(?, display_order),
            updated_at = ?
            WHERE id = ? AND section_id = ?`).run(
            b.label || null, draftVal, pubVal, blockStatus, b.display_order, timestamp, b.id, sectionId
          );
        }
      }
    }

    db.prepare('UPDATE cms_sections SET updated_at = ? WHERE id = ?').run(timestamp, sectionId);

    // Save revision snapshot
    const currentSnapshot = JSON.stringify({
      blocks: db.prepare('SELECT * FROM cms_content_blocks WHERE section_id = ?').all(sectionId)
    });
    db.prepare(`INSERT INTO cms_content_revisions(id, section_id, admin_email, change_type, snapshot, created_at)
      VALUES(?, ?, ?, ?, ?, ?)`).run(id(), sectionId, req.admin.email, publishNow ? 'publish_content' : 'save_draft_content', currentSnapshot, timestamp);

    logAction(req.admin, publishNow ? 'Published' : 'Drafted', `Content for section: ${section.name}`);
  });

  tx();
  res.json({ ok: true, message: publishNow ? 'Section content published successfully.' : 'Draft saved successfully.' });
}));

// 4. Image Upload & Validation for Section Slot
app.post('/api/admin/cms/sections/:id/images', privateApi, upload.single('file'), async (req, res) => {
  const sectionId = req.params.id;
  const section = db.prepare('SELECT * FROM cms_sections WHERE id = ?').get(sectionId);
  if (!section) return res.status(404).json({ error: 'Section not found.' });

  if (!req.file) return res.status(400).json({ error: 'Choose an image file to upload.' });
  const slotKey = req.body.slot_key || 'general';
  const altText = req.body.alt_text || '';
  const caption = req.body.caption || '';
  const publishNow = req.body.publishNow === 'true' || req.body.publishNow === true;

  // Find slot requirement if configured
  const requirement = db.prepare('SELECT * FROM cms_image_requirements WHERE section_id = ? AND slot_key = ?').get(sectionId, slotKey);

  // Validate image
  const valResult = await validateImageRequirement(req.file.buffer, requirement);
  if (!valResult.valid) {
    return res.status(400).json({ error: valResult.error, validation: valResult });
  }

  // Convert/save file
  const processed = await processMediaFile(req.file);
  const ext = processed.mimeType === 'image/webp' ? '.webp' : '.jpg';
  const filename = `${crypto.randomUUID()}${ext}`;
  const destination = path.join(uploadDir, filename);
  fs.writeFileSync(destination, processed.buffer, { flag: 'wx' });

  const recordId = id();
  const mediaUrl = `/uploads/${filename}`;
  const meta = valResult.metadata || {};
  const timestamp = now();

  const tx = db.transaction(() => {
    // If not allow_multiple, archive or replace existing images for this slot
    if (!requirement || !requirement.allow_multiple) {
      db.prepare('DELETE FROM cms_section_images WHERE section_id = ? AND slot_key = ?').run(sectionId, slotKey);
    }

    db.prepare(`INSERT INTO cms_section_images(id, section_id, slot_key, media_url, original_name, file_size, mime_type, width, height, dpi, alt_text, caption, status, display_order, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
      recordId, sectionId, slotKey, mediaUrl, req.file.originalname.slice(0, 200),
      processed.buffer.length, processed.mimeType, meta.width || 0, meta.height || 0, meta.dpi || 72,
      altText, caption, publishNow ? 'published' : 'draft', timestamp, timestamp
    );

    db.prepare('UPDATE cms_sections SET updated_at = ? WHERE id = ?').run(timestamp, sectionId);
    logAction(req.admin, 'Uploaded', `Image for ${section.name} (${slotKey})`);
  });

  tx();
  res.status(201).json({
    id: recordId,
    section_id: sectionId,
    slot_key: slotKey,
    media_url: mediaUrl,
    metadata: meta,
    validation: { valid: true },
    status: publishNow ? 'published' : 'draft'
  });
});

// Delete Section Image
app.delete('/api/admin/cms/sections/:id/images/:imageId', privateApi, (req, res) => {
  const { id: sectionId, imageId } = req.params;
  const image = db.prepare('SELECT * FROM cms_section_images WHERE id = ? AND section_id = ?').get(imageId, sectionId);
  if (!image) return res.status(404).json({ error: 'Section image not found.' });

  db.prepare('DELETE FROM cms_section_images WHERE id = ?').run(imageId);
  db.prepare('UPDATE cms_sections SET updated_at = ? WHERE id = ?').run(now(), sectionId);
  logAction(req.admin, 'Deleted', `Image ${image.original_name} from section ${sectionId}`);
  res.json({ ok: true, message: 'Image deleted successfully.' });
});

// Configure Section Image Requirements
app.put('/api/admin/cms/sections/:id/requirements', privateApi, handleValidation((req, res) => {
  const sectionId = req.params.id;
  const section = db.prepare('SELECT * FROM cms_sections WHERE id = ?').get(sectionId);
  if (!section) return res.status(404).json({ error: 'Section not found.' });

  const { requirements } = req.body;
  if (!Array.isArray(requirements)) return res.status(400).json({ error: 'Requirements must be an array.' });

  const timestamp = now();
  const tx = db.transaction(() => {
    for (const r of requirements) {
      if (r.id) {
        db.prepare(`UPDATE cms_image_requirements SET
          label = ?, min_width = ?, max_width = ?, min_height = ?, max_height = ?,
          exact_width = ?, exact_height = ?, aspect_ratio = ?, aspect_ratio_tolerance = ?,
          allowed_formats = ?, max_size_kb = ?, required = ?, allow_multiple = ?, help_text = ?, updated_at = ?
          WHERE id = ? AND section_id = ?`).run(
          r.label, r.min_width || 0, r.max_width || 10000, r.min_height || 0, r.max_height || 10000,
          r.exact_width || null, r.exact_height || null, r.aspect_ratio || null, r.aspect_ratio_tolerance || 0.05,
          r.allowed_formats || 'jpg,jpeg,png,webp,avif', r.max_size_kb || 5120, r.required ? 1 : 0, r.allow_multiple ? 1 : 0,
          r.help_text || '', timestamp, r.id, sectionId
        );
      } else if (r.slot_key) {
        db.prepare(`INSERT INTO cms_image_requirements(id, section_id, slot_key, label, min_width, max_width, min_height, max_height, exact_width, exact_height, aspect_ratio, aspect_ratio_tolerance, allowed_formats, max_size_kb, required, allow_multiple, help_text, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id(), sectionId, r.slot_key, r.label || r.slot_key, r.min_width || 0, r.max_width || 10000, r.min_height || 0, r.max_height || 10000,
          r.exact_width || null, r.exact_height || null, r.aspect_ratio || null, r.aspect_ratio_tolerance || 0.05,
          r.allowed_formats || 'jpg,jpeg,png,webp,avif', r.max_size_kb || 5120, r.required ? 1 : 0, r.allow_multiple ? 1 : 0,
          r.help_text || '', timestamp, timestamp
        );
      }
    }
  });

  tx();
  res.json({ ok: true, message: 'Image requirements updated.' });
}));

// 5. Marquee CRUD per Section
app.get('/api/admin/cms/sections/:id/marquees', privateApi, (req, res) => {
  const marquees = db.prepare('SELECT * FROM cms_marquees WHERE section_id = ? ORDER BY display_order ASC, created_at ASC').all(req.params.id);
  res.json(marquees);
});

app.post('/api/admin/cms/sections/:id/marquees', privateApi, handleValidation((req, res) => {
  const sectionId = req.params.id;
  const section = db.prepare('SELECT * FROM cms_sections WHERE id = ?').get(sectionId);
  if (!section) return res.status(404).json({ error: 'Section not found.' });

  const { text, link_url, direction, speed_seconds, bg_color, text_color, font_size_px, font_weight, display_order, is_active, start_date, expiry_date } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Marquee text is required.' });

  const recordId = id();
  const timestamp = now();

  db.prepare(`INSERT INTO cms_marquees(id, section_id, text, link_url, direction, speed_seconds, bg_color, text_color, font_size_px, font_weight, display_order, is_active, start_date, expiry_date, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    recordId, sectionId, text.trim(), link_url || '', direction || 'ltr', Number(speed_seconds) || 20,
    bg_color || '#1E61AC', text_color || '#FFFFFF', Number(font_size_px) || 14, font_weight || '600',
    Number(display_order) || 0, is_active === false || is_active === 0 ? 0 : 1, start_date || null, expiry_date || null,
    timestamp, timestamp
  );

  db.prepare('UPDATE cms_sections SET updated_at = ? WHERE id = ?').run(timestamp, sectionId);
  logAction(req.admin, 'Created', `Marquee message for ${section.name}`);
  res.status(201).json({ id: recordId, ok: true });
}));

app.put('/api/admin/cms/sections/:id/marquees/:marqueeId', privateApi, handleValidation((req, res) => {
  const { id: sectionId, marqueeId } = req.params;
  const existing = db.prepare('SELECT * FROM cms_marquees WHERE id = ? AND section_id = ?').get(marqueeId, sectionId);
  if (!existing) return res.status(404).json({ error: 'Marquee message not found.' });

  const { text, link_url, direction, speed_seconds, bg_color, text_color, font_size_px, font_weight, display_order, is_active, start_date, expiry_date } = req.body;
  const timestamp = now();

  db.prepare(`UPDATE cms_marquees SET
    text = COALESCE(?, text),
    link_url = COALESCE(?, link_url),
    direction = COALESCE(?, direction),
    speed_seconds = COALESCE(?, speed_seconds),
    bg_color = COALESCE(?, bg_color),
    text_color = COALESCE(?, text_color),
    font_size_px = COALESCE(?, font_size_px),
    font_weight = COALESCE(?, font_weight),
    display_order = COALESCE(?, display_order),
    is_active = COALESCE(?, is_active),
    start_date = COALESCE(?, start_date),
    expiry_date = COALESCE(?, expiry_date),
    updated_at = ?
    WHERE id = ? AND section_id = ?`).run(
    text ? text.trim() : null, link_url, direction, speed_seconds, bg_color, text_color,
    font_size_px, font_weight, display_order, is_active !== undefined ? (is_active ? 1 : 0) : null,
    start_date, expiry_date, timestamp, marqueeId, sectionId
  );

  db.prepare('UPDATE cms_sections SET updated_at = ? WHERE id = ?').run(timestamp, sectionId);
  logAction(req.admin, 'Updated', `Marquee message ${marqueeId}`);
  res.json({ ok: true, message: 'Marquee message updated.' });
}));

app.delete('/api/admin/cms/sections/:id/marquees/:marqueeId', privateApi, (req, res) => {
  const { id: sectionId, marqueeId } = req.params;
  db.prepare('DELETE FROM cms_marquees WHERE id = ? AND section_id = ?').run(marqueeId, sectionId);
  db.prepare('UPDATE cms_sections SET updated_at = ? WHERE id = ?').run(now(), sectionId);
  logAction(req.admin, 'Deleted', `Marquee message ${marqueeId}`);
  res.json({ ok: true, message: 'Marquee message deleted.' });
});

// 6. Section Full Publish Workflow
app.post('/api/admin/cms/sections/:id/publish', privateApi, (req, res) => {
  const sectionId = req.params.id;
  const section = db.prepare('SELECT * FROM cms_sections WHERE id = ?').get(sectionId);
  if (!section) return res.status(404).json({ error: 'Section not found.' });

  const timestamp = now();
  const tx = db.transaction(() => {
    // Promote draft content blocks to published
    db.prepare(`UPDATE cms_content_blocks SET
      published_value = draft_value,
      status = 'published',
      updated_at = ?
      WHERE section_id = ? AND status <> 'disabled'`).run(timestamp, sectionId);

    // Promote draft images to published
    db.prepare(`UPDATE cms_section_images SET
      status = 'published',
      updated_at = ?
      WHERE section_id = ?`).run(timestamp, sectionId);

    db.prepare(`UPDATE cms_sections SET status = 'published', updated_at = ? WHERE id = ?`).run(timestamp, sectionId);

    // Save revision
    db.prepare(`INSERT INTO cms_content_revisions(id, section_id, admin_email, change_type, snapshot, created_at)
      VALUES(?, ?, ?, 'full_publish', ?, ?)`).run(
      id(), sectionId, req.admin.email,
      JSON.stringify({
        blocks: db.prepare('SELECT * FROM cms_content_blocks WHERE section_id = ?').all(sectionId),
        images: db.prepare('SELECT * FROM cms_section_images WHERE section_id = ?').all(sectionId),
        marquees: db.prepare('SELECT * FROM cms_marquees WHERE section_id = ?').all(sectionId)
      }),
      timestamp
    );

    logAction(req.admin, 'Full Published', `Section: ${section.name}`);
  });

  tx();
  res.json({ ok: true, message: `Section ${section.name} is now fully published.` });
});

/* =========================================================
   COMPREHENSIVE CRUD ROUTES (CONTENT, IMAGES, MARQUEE, PDF)
   ========================================================= */


// Image specifications for strict dimension validation
const IMAGE_SPECS = {
  // Hero / Banners (1920 x 600)
  'bannerImage': { width: 1920, height: 600 },
  'heroImage': { width: 1920, height: 600 },
  'hero': { width: 1920, height: 600 },
  'banner': { width: 1920, height: 600 },

  // About Page
  'about_campus': { width: 1200, height: 800 },
  'about_students': { width: 1200, height: 800 },
  'circular': { width: 1200, height: 800 },
  'videoTour': { width: 1200, height: 800 },
  'poster': { width: 1200, height: 800 },
  'campusHighlights': { width: 1200, height: 800 },

  // Facilities / Campus
  'facility_classroom': { width: 1000, height: 700 },
  'campus': { width: 1200, height: 800 },
  'facilities': { width: 1200, height: 800 },

  // Promoters
  'facility': { width: 1200, height: 800 },
  'founder': { width: 800, height: 1000 },
  'hospital': { width: 1200, height: 800 },

  // Way We Work & Programs (4:3 ratio - 1200 x 900)
  'circularImage': { width: 1200, height: 900 },
  'videoTourImage': { width: 1200, height: 900 },
  'videoThumb': { width: 1200, height: 900 },
  'studentImage': { width: 1200, height: 900 },
  'studentExperienceImage': { width: 1200, height: 900 },
  'curriculumImage': { width: 1200, height: 900 },
  'marinersStarImage': { width: 1200, height: 900 },

  // Partners & Infrastructure Logos
  'technology-partners': { width: 400, height: 200 },
  'infrastructure-providers': { width: 400, height: 200 }
};

function getImageSpec(sectionId, slotKey) {
  if (sectionId === 'hero' || sectionId === 'banner') return { width: 1920, height: 600 };
  if (sectionId === 'technology-partners' || sectionId === 'infrastructure-providers') return { width: 400, height: 200 };
  if (slotKey && slotKey.startsWith('collection_') && (sectionId === 'technology-partners' || sectionId === 'infrastructure-providers')) return { width: 400, height: 200 };
  if (sectionId === 'gallery' || sectionId === 'photo-gallery' || sectionId === 'activities') return { width: 1200, height: 900 };
  if (sectionId === 'way-we-work') {
    return { width: 1200, height: 900 };
  }
  if (sectionId === 'about' || sectionId === 'campus' || sectionId === 'facilities') return { width: 1200, height: 800 };
  if (slotKey && IMAGE_SPECS[slotKey]) return IMAGE_SPECS[slotKey];
  if (slotKey && (slotKey.startsWith('hero_') || slotKey.includes('banner') || slotKey.includes('Banner'))) return { width: 1920, height: 600 };
  if (slotKey && slotKey.startsWith('advisor_')) return { width: 600, height: 600 };
  if (slotKey && (slotKey.startsWith('sportsCards_') || slotKey.startsWith('sliderImages_'))) return { width: 1200, height: 800 };
  if (slotKey && slotKey.startsWith('curriculumImages_')) return { width: 1200, height: 900 };
  if (sectionId === 'programs-offered' || sectionId === 'programs' || sectionId === 'academics') {
    return { width: 1200, height: 900 };
  }
  if (sectionId && IMAGE_SPECS[sectionId]) return IMAGE_SPECS[sectionId];
  return { width: 1200, height: 800 };
}

const SECTION_DOC_MAP = {
  'hero': 'home',
  'banner': 'home',
  'about': 'about',
  'campus': 'sections',
  'facilities': 'sections',
  'academics': 'sections',
  'programs': 'sections',
  'activities': 'sections',
  'sports': 'sections',
  'gallery': 'sections',
  'videos': 'sections',
  'philosophy': 'sections',
  'testimonials': 'sections',
  'announcements': 'sections',
  'technology-partners': 'sections',
  'infrastructure-providers': 'sections',
  'announcements': 'sections',
  'technology-partners': 'sections',
  'infrastructure-providers': 'sections',
  'leadership': 'sections',
  'parents-corner': 'sections',
  'footer': 'sections',
  'promoters': 'promoters',
  'advisory-board': 'advisory-board',
  'way-we-work': 'way-we-work',
  'programs-offered': 'programs-offered',
  'chateauFrancais': 'chateauFrancais'
};

const defaultAdvisors = [
  {
    name: 'Dr. Sakthivel M.D',
    designation: 'Advisory Board member of ENPEE International',
    location: 'Karaikal, Puducherry',
    tag: 'Medical Council',
    initials: 'DS',
    image: '',
    details: [
      'HOD of General Medicine, Vinayaka Mission\'s Medical College, Karaikal.',
      'Advisory Board member guiding institutional healthcare standards, student wellness protocols, and campus health advisory.',
      'Distinguished physician providing clinical expertise and medical counsel for holistic community and pupil development.'
    ]
  },
  {
    name: 'Mr. T.S. Hariharan B.E., M.B.A',
    designation: 'Director of Operations · Starkey Hearing Technologies India',
    location: 'Noida, New Delhi',
    tag: 'Operations & Sports',
    initials: 'TH',
    image: '',
    details: [
      'An ardent sports personality represented TN Hockey team at National Level in under 14 and 16 levels.',
      'An Engineer by profession with rich experiences in the field of Medical Electronics & Instrumentation and manufacturing of Hearing Devices.',
      'A team head / Director of Operations STARKEY Hearing Technologies India, an American MNC in NOIDA with an Engineering Degree from Bharathidasan University and a PG degree in Operations Management from Symbiosis.',
      'Member of School Management Committee in the reputed The Khaitan School, Noida.'
    ]
  },
  {
    name: 'Prof. M. Najimudeen., M.Com., M.Phil., PGDCA.,',
    designation: 'Director, Annai group of institutions, Kovilachery, Kumbakonam',
    location: 'Kovilachery, Kumbakonam',
    tag: 'Higher Education & Governance',
    initials: 'MN',
    image: '',
    details: [
      'Director, Annai group of institutions, Kovilachery, Kumbakonam.',
      'Former Senate Member, Barathidasan University, Tiruchirappalli.',
      'Former Member Education Committee, Wakf Board Tamilnadu.',
      'School Committee Member in several Schools across Tamil Nadu.'
    ]
  }
];

const COLLECTION_MAP = {
  'campus': 'facilities',
  'facilities': 'facilities',
  'academics': 'programs',
  'programs': 'programs',
  'activities': 'activities',
  'sports': 'activities',
  'gallery': 'gallery',
  'videos': 'youtubeVideos',
  'youtubeVideos': 'youtubeVideos',
  'technology-partners': 'technologyPartners',
  'infrastructure-providers': 'infrastructureProviders',
  'leadership': 'leadership'
};

// 1. GET Section Details & Content
function handleGetSectionDetails(req, res) {
  const id = req.params.id;
  const docKey = SECTION_DOC_MAP[id] || id;

  const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ? OR key = ?').get(docKey, id);
  let content = doc ? JSON.parse(doc.payload) : {};

  let displayContent = {};
  let images = [];
  let items = [];

  if (id === 'technology-partners' || id === 'infrastructure-providers') {
    const collectionName = id === 'technology-partners' ? 'technologyPartners' : 'infrastructureProviders';
    const headingKey = id === 'technology-partners' ? 'partnersHeading' : 'infrastructureHeading';
    
    const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('sections');
    const sectionData = doc ? JSON.parse(doc.payload) : {};
    
    displayContent = {
      heading: sectionData[headingKey] || (id === 'technology-partners' ? 'Technology Partners' : 'Infrastructure Providers')
    };
    
    // Fetch items from the specific collection
    const collectionItems = db.prepare(`SELECT id, payload FROM content_items WHERE collection = ? ORDER BY json_extract(payload, '$.displayOrder'), created_at`).all(collectionName);
    collectionItems.forEach((r, i) => {
      const p = JSON.parse(r.payload);
      displayContent[`item_${r.id}_title`] = p.title;
      if (p.image) {
        images.push({ slot: `collection_${r.id}`, url: p.image, title: p.title || `Item ${i+1}` });
      } else {
        images.push({ slot: `collection_${r.id}`, url: '', title: p.title || `Item ${i+1}` });
      }
    });
    
    images.forEach(img => {
      const spec = getImageSpec(id, img.slot);
      img.requiredWidth = spec.width;
      img.requiredHeight = spec.height;
      img.requiredSize = `${spec.width} x ${spec.height}`;
    });
    return res.json({ content: displayContent, images });
  }

  if (id === 'contact') {
    const contactDoc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('contact');
    const contactData = contactDoc ? JSON.parse(contactDoc.payload) : {};
    
    displayContent = {
      schoolName: contactData.schoolName || 'ENPEE International School',
      address: contactData.address || '',
      phone: contactData.phone || '',
      mobile: contactData.mobile || '',
      email: contactData.email || '',
      whatsapp: contactData.whatsapp || '',
      mapsUrl: contactData.mapsUrl || '',
      formHeading: contactData.formHeading || 'Send us a message',
      nameLabel: contactData.nameLabel || 'Your name',
      emailLabel: contactData.emailLabel || 'Email',
      messageLabel: contactData.messageLabel || 'Message',
      submitButton: contactData.submitButton || 'Send Message'
    };
    
    return res.json({ content: displayContent, images: [] });
  }

  if (id === 'sports-academy' || id === 'sportsAcademy') {
    displayContent = {
      heading: content.title || content.heading || 'ENPEE Sports Academy',
      description: content.description || 'Cultivating athletic talent, endurance, sportsmanship, and leadership under certified physical education coaches and professional sports grounds.'
    };

    // 1. Top Banner Image
    images.push({
      slot: 'bannerImage',
      url: content.bannerImage || '/assets/images/campus-banner.webp',
      title: 'Top Banner'
    });

    // 2. Sports Facility Cards (8 cards)
    const sportsCards = (Array.isArray(content.sportsCards) && content.sportsCards.length > 0)
      ? content.sportsCards
      : defaultSportsCards;
    
    sportsCards.forEach((sport, i) => {
      displayContent['sportCard_' + i + '_title'] = sport.title || '';
      displayContent['sportCard_' + i + '_badge'] = sport.badge || '';
      displayContent['sportCard_' + i + '_desc'] = sport.description || sport.desc || '';
      images.push({
        slot: 'sportsCards_' + i,
        url: sport.image || '',
        title: 'Sport: ' + (sport.title || ('Card ' + (i + 1)))
      });
    });

    // 3. Bottom Campus Slider Images
    const sliderImages = (Array.isArray(content.sliderImages) && content.sliderImages.length > 0)
      ? content.sliderImages
      : defaultSportsSliderImages;

    sliderImages.forEach((url, i) => {
      images.push({
        slot: 'sliderImages_' + i,
        url: url || '',
        title: 'Campus Slider Image ' + (i + 1)
      });
    });
  } else if (id === 'hero' || id === 'banner') {
    displayContent = {
      heroHeading: content.heroHeading || '',
      heroDescription: content.heroDescription || '',
      heroPrimaryText: content.heroPrimaryText || '',
      heroPrimaryLink: content.heroPrimaryLink || '',
      heading: content.heroHeading || content.heading || '',
      description: content.heroDescription || content.description || '',
      buttonText: content.heroPrimaryText || content.buttonText || '',
      slideSpeed: content.heroSlideSpeed || content.slideSpeed || 3,
      heroSlideSpeed: content.heroSlideSpeed || content.slideSpeed || 3,
      slideDirection: content.heroSlideDirection || 'left',
      heroSlideDirection: content.heroSlideDirection || 'left'
    };

    let heroImgs = Array.isArray(content.heroImages) ? content.heroImages : [];
    if (heroImgs.length === 0 && content.heroImage) heroImgs = [content.heroImage];
    if (heroImgs.length === 0) {
      heroImgs = [
        '/assets/images/campus-banner.webp',
        '/assets/images/5-acre-campus-secured.jpg',
        '/assets/images/interactive-digitized.jpg',
        '/assets/images/community-football.jpg'
      ];
    }
    heroImgs.forEach((url, i) => {
      if (url) images.push({ slot: 'heroImages_' + i, url, title: 'Hero Banner ' + (i + 1) });
    });
  } else if (id === 'about') {
    displayContent = {
      heading: content.title || content.heading || 'About ENPEE International School',
      description: content.description || 'Learn about ENPEE International School...',
      intro: content.introduction || '',
      introduction: content.introduction || '',
      vision: content.vision || '',
      mission: content.mission || ''
    };

    // Map the specific images from the About page and homepage About section
    images.push({
      slot: 'noticeImage',
      url: content.noticeImage || '/assets/images/certificate/imgi_4_enpee-admission-flyer.jpg',
      title: 'Admission Circular (Official Notice)'
    });
    images.push({
      slot: 'videoImage',
      url: content.videoImage || '/assets/images/video-thumbnails/annual-sports-day.jpg',
      title: 'Modern Learning Methodologies (Campus Video)'
    });
    images.push({
      slot: 'posterImage',
      url: content.posterImage || '/assets/images/video-thumbnails/admissions-open.jpg',
      title: 'Admissions Open 2026–27 Poster'
    });
    images.push({
      slot: 'campusHighlightImage',
      url: content.campusHighlightImage || '/assets/images/video-thumbnails/annual-day-celebrations.jpg',
      title: 'Campus Inauguration & Celebrations'
    });

    // Homepage About Visuals
    const photosList = (Array.isArray(content.photos) && content.photos.length > 0)
      ? content.photos
      : ['/assets/images/5-acre-campus-secured.jpg', '/assets/images/interactive-digitized.jpg'];
    const photoTitles = ['Our Campus (Homepage Visual)', 'Learning Together (Homepage Visual)'];
    photosList.forEach((url, i) => {
      images.push({ slot: 'photos_' + i, url: url || '', title: photoTitles[i] || ('School Photo ' + (i + 1)) });
    });
  } else if (id === 'campus' || id === 'facilities') {
    displayContent = {
      heading: content.campusHeading || 'An Inspiring Environment for Every Learner',
      description: content.campusDescription || '',
      campusEyebrow: content.campusEyebrow || 'Campus & Facilities',
      campusHeading: content.campusHeading || 'An Inspiring Environment for Every Learner',
      campusDescription: content.campusDescription || '',
      campusLinkText: content.campusLinkText || 'Explore School Gallery →',
      campusLinkUrl: content.campusLinkUrl || '#gallery'
    };
  } else if (id === 'academics' || id === 'programs') {
    displayContent = {
      academicsEyebrow: content.academicsEyebrow || 'Academics',
      academicsHeading: content.academicsHeading || 'Programs for 2026–27',
      academicsDescription: content.academicsDescription || ''
    };
  } else if (id === 'activities') {
    displayContent = {
      heading: content.activitiesHeading || 'Learning Beyond the Classroom',
      activitiesEyebrow: content.activitiesEyebrow || 'Activities',
      activitiesHeading: content.activitiesHeading || 'Learning Beyond the Classroom'
    };
  } else if (id === 'sports') {
    displayContent = {
      heading: content.sportsHeading || 'ENPEE Sports Academy',
      description: content.sportsDescription || '',
      sportsHeading: content.sportsHeading || 'ENPEE Sports Academy',
      sportsDescription: content.sportsDescription || ''
    };
  } else if (id === 'gallery') {
    displayContent = {
      heading: content.galleryHeading || 'Moments at ENPEE',
      description: content.galleryDescription || 'Explore learning, activities and school life across our campus.',
      galleryEyebrow: content.galleryEyebrow || 'Campus life',
      galleryHeading: content.galleryHeading || 'Moments at ENPEE',
      galleryDescription: content.galleryDescription || 'Explore learning, activities and school life across our campus.'
    };
  } else if (id === 'videos') {
    displayContent = {
      videosHeading: content.videosHeading || 'Experience ENPEE International School',
      videosSubtitle: content.videosSubtitle || ''
    };
  } else if (id === 'philosophy') {
    displayContent = {
      philosophyEyebrow: content.philosophyEyebrow || 'Our Educational Philosophy',
      philosophyHeading: content.philosophyHeading || 'KNOWLEDGE | INNOVATION | EXCELLENCE',
      philosophyDescription: content.philosophyDescription || ''
    };
  } else if (id === 'testimonials') {
    displayContent = {
      heading: content.testimonialsHeading || content.heading || 'Testimonials',
      message: content.testimonialsMessage || content.message || 'Parent testimonials will be shared here once they are approved for publication.'
    };
    return res.json({ content: displayContent, images: [] });
  } else if (id === 'announcements') {
    displayContent = {
      heading: content.announcementsHeading || content.heading || 'Announcements & News',
      newsText: content.newsText || 'Admission Open 2026-2027',
      linkUrl: content.announcementsLinkUrl || content.linkUrl || '/news-events'
    };
    return res.json({ content: displayContent, images: [] });
  } else if (id === 'leadership') {
    displayContent = {
      leadershipEyebrow: content.leadershipEyebrow || 'Leadership',
      leadershipHeading: content.leadershipHeading || 'Promoters & School Management'
    };
  } else if (id === 'promoters') {
    displayContent = {
      heading: content.title || content.heading || 'Promoters & Institutional Background',
      description: content.description || 'Driven by a six-decade legacy of pharmaceutical innovation, philanthropic healthcare, and educational excellence across Tamil Nadu and Puducherry.'
    };

    images.push({
      slot: 'facilityImage',
      url: content.facilityImage || 'https://www.enpeekkl.com/images/national-pharma.jpg',
      title: 'National Pharma Manufacturing Facility'
    });
    images.push({
      slot: 'founderImage',
      url: content.founderImage || '/assets/images/management/chairman.jpg',
      title: 'Rtn. PHF. Hajee L. Kamal Batcha (Founder)'
    });
    images.push({
      slot: 'hospitalImage',
      url: content.hospitalImage || '/assets/images/Promoters/hospital-operation-theatre.jpg',
      title: 'The National Pharma Hospital & Research Institute'
    });
  } else if (id === 'advisory-board') {
    displayContent = {
      heading: content.title || content.heading || 'Advisory Board',
      description: content.description || 'Meet the distinguished academic, medical, and industry advisors supporting ENPEE International School.'
    };

    // 1. Top Banner Image (National Pharma)
    images.push({
      slot: 'bannerImage',
      url: content.bannerImage || '/assets/images/Advisory Board/imgi_7_banner-0002.jpg',
      title: 'Top Banner (National Pharma)'
    });

    // 2. Advisory Board Profiles
    const advisors = (Array.isArray(content.advisors) && content.advisors.length > 0) ? content.advisors : defaultAdvisors;
    advisors.forEach((advisor, i) => {
      images.push({
        slot: `advisors_${i}`,
        url: advisor.image || '',
        title: `Advisor: ${advisor.name || 'Profile ' + (i + 1)}`
      });
    });
  } else if (id === 'way-we-work') {
    displayContent = {
      heading: content.title || content.heading || 'The Way We Work',
      intro: content.introduction || content.intro || 'ENPEE provides Developmentally Appropriate Practice (DAP), a framework designed to promote young children’s optimal learning and development through a strengths-based, play-based approach to joyful, engaged learning.',
      curriculum: content.curriculumText || content.curriculum || 'We adhere to the nationally recognized NCERT textbooks and curriculum guidelines. Additionally, our students benefit from a diverse multilingual offering including Tamil, Arabic, French, and Hindi, nurturing both global perspective and cultural roots.',
      marinersStar: content.marinersStarText || content.marinersStar || 'At ENPEE, these five educator practices illuminate our pathway to academic and holistic student success.'
    };

    // Exactly the 4 feature cards on "The Way We Work" page (4:3)
    images.push({
      slot: 'curriculumImage',
      url: content.curriculumImage || (content.curriculumImages && content.curriculumImages[0]) || '/assets/images/carosel/003.jpg',
      title: 'NCERT & Curriculum (Card 1)'
    });
    images.push({
      slot: 'extraCurricularImage',
      url: content.extraCurricularImage || content.circularImage || '/assets/images/community-football.jpg',
      title: 'Extra Curricular Activities (Card 2)'
    });
    images.push({
      slot: 'roboticsImage',
      url: content.roboticsImage || content.studentImage || '/assets/images/interactive-digitized.jpg',
      title: 'Robotics & Innovation (Card 3)'
    });
    images.push({
      slot: 'marinersStarImage',
      url: content.marinersStarImage || '/assets/images/school-img.jpg',
      title: "Mariner's Star (Card 4)"
    });
  } else if (id === 'programs-offered') {
    displayContent = {
      heading: content.heading || content.title || 'Programs Offered',
      description: content.description || 'ENPEE International School offers comprehensive programs from Pre-KG to Class IX with holistic CBSE curriculum and modern facilities.'
    };

    images.push({
      slot: 'bannerImage',
      url: content.bannerImage || '/assets/images/interactive-digitized.jpg',
      title: 'Top Banner'
    });
    images.push({
      slot: 'kgImage',
      url: content.kgImage || '/assets/images/carosel/009.jpg',
      title: 'KG – UKG Kindergarten'
    });
    images.push({
      slot: 'primaryImage',
      url: content.primaryImage || '/assets/images/5-acre-campus-secured.jpg',
      title: 'Primary & Middle School (Classes I to IX)'
    });
    images.push({
      slot: 'roboticsImage',
      url: content.roboticsImage || '/assets/images/interactive-digitized.jpg',
      title: 'Robotics & Coding Lab (STEM & Innovation)'
    });
    images.push({
      slot: 'eventsImage',
      url: content.eventsImage || '/assets/images/certificate/first-annual-day-celebration.jpeg',
      title: 'Events & Celebrations (Arts & Culture)'
    });
    images.push({
      slot: 'sportsImage',
      url: content.sportsImage || '/assets/images/carosel/sports-001.jpg',
      title: 'ENPEE Sports Academy (Athletic Excellence)'
    });
    images.push({
      slot: 'smartBoardsImage',
      url: content.smartBoardsImage || '/assets/images/interactive-digitized.jpg',
      title: 'Smart Boards & Digitized Classrooms'
    });
    images.push({
      slot: 'athleticsImage',
      url: content.athleticsImage || '/assets/images/community-football.jpg',
      title: 'Athletics & Games (Physical Education)'
    });
    images.push({
      slot: 'sportsDayImage',
      url: content.sportsDayImage || '/assets/images/certificate/first-annual-day-celebration.jpeg',
      title: 'Sports Day & Achievements'
    });
  } else if (id === 'parents-corner') {
    displayContent = {
      parentsCornerHeading: content.parentsCornerHeading || 'Parents’ Corner.',
      parentsCornerIntro: content.parentsCornerIntro || '',
      downloadsText: content.downloadsText || 'Downloads & documents',
      downloadsUrl: content.downloadsUrl || ''
    };
  } else if (id === 'footer') {
    displayContent = {
      footerDescription: content.footerDescription || '',
      contactAddress: content.contactAddress || '',
      contactPhone: content.contactPhone || '',
      contactEmail: content.contactEmail || ''
    };
  } else {
    Object.assign(displayContent, content);
  }

  // Extract collection items from content_items table
  const targetCollection = COLLECTION_MAP[id];
  if (targetCollection) {
    try {
      const rows = db.prepare("SELECT id, payload FROM content_items WHERE collection = ? ORDER BY json_extract(payload, '$.displayOrder'), created_at").all(targetCollection);
      rows.forEach((r, i) => {
        const p = JSON.parse(r.payload);
        if (id === 'sports' && p.category && p.category !== 'Sports') return;
        if ((id === 'campus' || id === 'facilities') && !p.image) return;
        if (id === 'gallery' && !p.image) return;

        const cardTitle = p.title || p.name || ('Item ' + (i + 1));
        const cardImg = p.image || p.thumbnail || p.photo || '';

        items.push({
          itemId: r.id,
          title: cardTitle,
          description: p.description || p.detail || '',
          category: p.category || '',
          image: cardImg,
          collection: targetCollection
        });

        if (cardImg) {
          images.push({
            slot: 'collection_' + r.id,
            url: cardImg,
            title: cardTitle,
            itemId: r.id,
            collection: targetCollection
          });
        }
      });
    } catch (err) {
      console.warn('Collection fetch error:', err);
    }
  }

  images.forEach(img => {
    const spec = getImageSpec(id, img.slot);
    img.requiredWidth = spec.width;
    img.requiredHeight = spec.height;
    img.requiredSize = `${spec.width} x ${spec.height}`;
  });

  res.json({ content: displayContent, images, items, collection: targetCollection, id, docKey });
}

app.get('/api/admin/sections/:id/details', privateApi, handleGetSectionDetails);
app.get('/api/admin/sections/:id', privateApi, handleGetSectionDetails);

// 2. PUT Section Content & Items
function handlePutSectionContent(req, res) {
  const id = req.params.id;
  const docKey = SECTION_DOC_MAP[id] || id;
  const { content, items } = req.body;
  const ts = new Date().toISOString();

  // If content object is passed, update site_documents
  if (content && typeof content === 'object') {
    if (id === 'testimonials') {
      const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('sections');
      if (doc) {
        const payload = JSON.parse(doc.payload);
        payload.testimonialsHeading = content.heading !== undefined ? content.heading : (content.testimonialsHeading || payload.testimonialsHeading);
        payload.testimonialsMessage = content.message !== undefined ? content.message : (content.testimonialsMessage || payload.testimonialsMessage);
        db.prepare('UPDATE site_documents SET payload = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(payload), new Date().toISOString(), 'sections');
      }
      logAction(req.admin, 'Updated', 'Section details: ' + id);
      return res.json({ ok: true });
    }

    if (id === 'announcements') {
      const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('sections');
      if (doc) {
        const payload = JSON.parse(doc.payload);
        payload.announcementsHeading = content.heading !== undefined ? content.heading : (content.announcementsHeading || payload.announcementsHeading);
        payload.newsText = content.newsText !== undefined ? content.newsText : (payload.newsText || '');
        payload.announcementsLinkUrl = content.linkUrl !== undefined ? content.linkUrl : (content.announcementsLinkUrl || payload.announcementsLinkUrl || '');
        db.prepare('UPDATE site_documents SET payload = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(payload), new Date().toISOString(), 'sections');
      }
      logAction(req.admin, 'Updated', 'Section details: ' + id);
      return res.json({ ok: true });
    }

    if (id === 'technology-partners' || id === 'infrastructure-providers') {
      const collectionName = id === 'technology-partners' ? 'technologyPartners' : 'infrastructureProviders';
      const headingKey = id === 'technology-partners' ? 'partnersHeading' : 'infrastructureHeading';
      
      // Update Heading
      const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('sections');
      if (doc) {
        const payload = JSON.parse(doc.payload);
        payload[headingKey] = content.heading;
        db.prepare('UPDATE site_documents SET payload = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(payload), new Date().toISOString(), 'sections');
      }
      
      // Update Items
      Object.keys(content).forEach(key => {
        if (key.startsWith('item_') && key.endsWith('_title')) {
          const itemId = key.replace('item_', '').replace('_title', '');
          const row = db.prepare('SELECT payload FROM content_items WHERE id = ? AND collection = ?').get(itemId, collectionName);
          if (row) {
            const p = JSON.parse(row.payload);
            p.title = content[key];
            db.prepare('UPDATE content_items SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(p), new Date().toISOString(), itemId);
          }
        }
      });
      
      logAction(req.admin, 'Updated', 'Section details: ' + id);
      return res.json({ ok: true });
    }

    if (id === 'testimonials') {
      const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('sections');
      if (doc) {
        const payload = JSON.parse(doc.payload);
        payload.testimonialsHeading = content.heading !== undefined ? content.heading : (content.testimonialsHeading || payload.testimonialsHeading);
        payload.testimonialsMessage = content.message !== undefined ? content.message : (content.testimonialsMessage || payload.testimonialsMessage);
        db.prepare('UPDATE site_documents SET payload = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(payload), new Date().toISOString(), 'sections');
      }
      logAction(req.admin, 'Updated', 'Section details: ' + id);
      return res.json({ ok: true });
    }

    if (id === 'announcements') {
      const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('sections');
      if (doc) {
        const payload = JSON.parse(doc.payload);
        payload.announcementsHeading = content.heading !== undefined ? content.heading : (content.announcementsHeading || payload.announcementsHeading);
        payload.newsText = content.newsText !== undefined ? content.newsText : (payload.newsText || '');
        payload.announcementsLinkUrl = content.linkUrl !== undefined ? content.linkUrl : (content.announcementsLinkUrl || payload.announcementsLinkUrl || '');
        db.prepare('UPDATE site_documents SET payload = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(payload), new Date().toISOString(), 'sections');
      }
      logAction(req.admin, 'Updated', 'Section details: ' + id);
      return res.json({ ok: true });
    }

    if (id === 'technology-partners' || id === 'infrastructure-providers') {
      const collectionName = id === 'technology-partners' ? 'technologyPartners' : 'infrastructureProviders';
      const headingKey = id === 'technology-partners' ? 'partnersHeading' : 'infrastructureHeading';
      
      // Update Heading
      const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('sections');
      if (doc) {
        const payload = JSON.parse(doc.payload);
        payload[headingKey] = content.heading;
        db.prepare('UPDATE site_documents SET payload = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(payload), new Date().toISOString(), 'sections');
      }
      
      // Update Items
      Object.keys(content).forEach(key => {
        if (key.startsWith('item_') && key.endsWith('_title')) {
          const itemId = key.replace('item_', '').replace('_title', '');
          const row = db.prepare('SELECT payload FROM content_items WHERE id = ? AND collection = ?').get(itemId, collectionName);
          if (row) {
            const p = JSON.parse(row.payload);
            p.title = content[key];
            db.prepare('UPDATE content_items SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(p), new Date().toISOString(), itemId);
          }
        }
      });
      
      logAction(req.admin, 'Updated', 'Section details: ' + id);
      return res.json({ ok: true });
    }

    const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ? OR key = ?').get(docKey, id);
    let existing = {};
    if (doc) {
      try { existing = JSON.parse(doc.payload); } catch { }
    }
    const updated = { ...existing, ...content };
    if (id === 'sports-academy' || id === 'sportsAcademy') {
      if (content.heading) {
        updated.title = content.heading;
        updated.heading = content.heading;
      }
      if (content.description) {
        updated.description = content.description;
      }

      if (!Array.isArray(updated.sportsCards) || updated.sportsCards.length === 0) {
        updated.sportsCards = JSON.parse(JSON.stringify(defaultSportsCards));
      }

      Object.keys(content).forEach(key => {
        if (key.startsWith('sportCard_')) {
          const parts = key.split('_');
          const index = parseInt(parts[1], 10);
          const field = parts[2];
          if (!updated.sportsCards[index]) updated.sportsCards[index] = {};
          if (field === 'desc' || field === 'description') {
            updated.sportsCards[index].description = content[key];
            updated.sportsCards[index].desc = content[key];
          } else {
            updated.sportsCards[index][field] = content[key];
          }
        }
      });
    }
    if (id === 'about') {
      if (content.intro && !content.introduction) updated.introduction = content.intro;
      if (content.heading) {
        updated.title = content.heading;
        updated.heading = content.heading;
      }
    }
    if (id === 'promoters') {
      if (content.heading) {
        updated.title = content.heading;
        updated.heading = content.heading;
      }
      if (content.description) {
        updated.description = content.description;
      }
    }
    if (id === 'advisory-board') {
      if (content.heading) {
        updated.title = content.heading;
        updated.heading = content.heading;
      }
      if (content.description) {
        updated.description = content.description;
      }
    }
    if (id === 'way-we-work') {
      if (content.heading) {
        updated.title = content.heading;
        updated.heading = content.heading;
      }
      if (content.intro) {
        updated.introduction = content.intro;
        updated.intro = content.intro;
      }
      if (content.curriculum) {
        updated.curriculumText = content.curriculum;
        updated.curriculum = content.curriculum;
      }
      if (content.marinersStar) {
        updated.marinersStarText = content.marinersStar;
        updated.marinersStar = content.marinersStar;
      }
    }
    if (content.heading) {
      if (id === 'campus' || id === 'facilities') updated.campusHeading = content.heading;
      else if (id === 'activities') updated.activitiesHeading = content.heading;
      else if (id === 'gallery') updated.galleryHeading = content.heading;
      else if (id === 'sports') updated.sportsHeading = content.heading;
      else if (!content.heroHeading) updated.heroHeading = content.heading;
    }
    if (content.description) {
      if (id === 'campus' || id === 'facilities') updated.campusDescription = content.description;
      else if (id === 'gallery') updated.galleryDescription = content.description;
      else if (id === 'sports') updated.sportsDescription = content.description;
      else if (!content.heroDescription) updated.heroDescription = content.description;
    }
    if (content.campusHeading) updated.campusHeading = content.campusHeading;
    if (content.campusDescription) updated.campusDescription = content.campusDescription;
    if (content.activitiesHeading) updated.activitiesHeading = content.activitiesHeading;
    if (content.galleryHeading) updated.galleryHeading = content.galleryHeading;
    if (content.galleryDescription) updated.galleryDescription = content.galleryDescription;
    if (content.buttonText && !content.heroPrimaryText) updated.heroPrimaryText = content.buttonText;
    if (content.intro && !content.introduction) updated.introduction = content.intro;
    if (content.slideSpeed !== undefined) {
      updated.heroSlideSpeed = parseInt(content.slideSpeed, 10) || 3;
      updated.slideSpeed = parseInt(content.slideSpeed, 10) || 3;
    }
    if (content.heroSlideSpeed !== undefined) {
      updated.heroSlideSpeed = parseInt(content.heroSlideSpeed, 10) || 3;
      updated.slideSpeed = parseInt(content.heroSlideSpeed, 10) || 3;
    }
    if (content.slideDirection !== undefined) updated.heroSlideDirection = content.slideDirection === 'right' ? 'right' : 'left';
    if (content.heroSlideDirection !== undefined) updated.heroSlideDirection = content.heroSlideDirection === 'right' ? 'right' : 'left';

    db.prepare('INSERT INTO site_documents (key, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at')
      .run(docKey, JSON.stringify(updated), ts);

    if (id === 'hero' || id === 'banner') {
      try {
        const secDoc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('sections');
        if (secDoc) {
          const secPayload = JSON.parse(secDoc.payload);
          secPayload.heroSlideSpeed = updated.heroSlideSpeed;
          secPayload.heroSlideDirection = updated.heroSlideDirection;
          db.prepare('UPDATE site_documents SET payload = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(secPayload), ts, 'sections');
        }
      } catch { }
    }
  }

  // If items array is passed, update each item in content_items
  if (Array.isArray(items)) {
    items.forEach(item => {
      if (!item.itemId) return;
      const row = db.prepare('SELECT payload FROM content_items WHERE id = ?').get(item.itemId);
      if (row) {
        let p = {};
        try { p = JSON.parse(row.payload); } catch { }
        if (item.title !== undefined) p.title = item.title;
        if (item.description !== undefined) p.description = item.description;
        if (item.category !== undefined) p.category = item.category;
        if (item.image !== undefined) p.image = item.image;
        db.prepare('UPDATE content_items SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(p), ts, item.itemId);
      }
    });
  }

  logAction(req.admin, 'Updated', 'Section details: ' + id);
  res.json({ ok: true });
}

app.put('/api/admin/sections/:id/details', privateApi, handlePutSectionContent);
app.put('/api/admin/sections/:id', privateApi, handlePutSectionContent);

// Collection partial update hook
app.put('/api/admin/collections/:collection/:id', privateApi, (req, res, next) => {
  const { collection, id: recordId } = req.params;
  const existing = db.prepare('SELECT payload FROM content_items WHERE id = ?').get(recordId);
  if (existing) {
    let p = {};
    try { p = JSON.parse(existing.payload); } catch { }
    if (req.body.title !== undefined) p.title = req.body.title;
    if (req.body.description !== undefined) p.description = req.body.description;
    if (req.body.category !== undefined) p.category = req.body.category;
    if (req.body.image !== undefined) p.image = req.body.image;
    const ts = new Date().toISOString();
    db.prepare('UPDATE content_items SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(p), ts, recordId);
    logAction(req.admin, 'Updated', collection + ' item: ' + recordId);
    return res.json({ id: recordId, ...p });
  }
  next();
});

// 3. POST: Add New Image (Registered BEFORE :slotKey route)
app.post('/api/admin/sections/:id/images/add', privateApi, upload.single('image'), async (req, res) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  try {
    const spec = getImageSpec(id, 'add');
    const metadata = await sharp(req.file.buffer).metadata();

    if (metadata.width !== spec.width || metadata.height !== spec.height) {
      const expectedRatio = spec.width / spec.height;
      const actualRatio = metadata.width / metadata.height;
      const ratioDiff = Math.abs(expectedRatio - actualRatio) / expectedRatio;
      let isAllowed = ratioDiff <= 0.05;
      if (!isAllowed && (id === 'gallery' || id === 'photo-gallery' || id === 'activities')) {
        const ratioDiff32 = Math.abs(1.5 - actualRatio) / 1.5;
        if (ratioDiff32 <= 0.05) isAllowed = true;
      }
      if (!isAllowed) {
        return res.status(400).json({ 
          error: `Upload Failed – Image size must be ${spec.width} × ${spec.height} px (Ratio ${spec.width}:${spec.height}). Your image is ${metadata.width} × ${metadata.height} px.` 
        });
      }
    }

    const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;
    const outputPath = path.join(uploadDir, filename);
    await sharp(req.file.buffer).resize(spec.width, spec.height, { fit: 'cover' }).webp({ quality: 85 }).toFile(outputPath);
    const url = '/uploads/' + filename;
    const isHero = (id === 'hero' || id === 'banner');
    const ts = new Date().toISOString();

    if (isHero) {
      const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('home');
      let payload = doc ? JSON.parse(doc.payload) : {};
      if (!Array.isArray(payload.heroImages)) {
        payload.heroImages = payload.heroImage ? [payload.heroImage] : [
          '/assets/images/campus-banner.webp',
          '/assets/images/5-acre-campus-secured.jpg',
          '/assets/images/interactive-digitized.jpg',
          '/assets/images/community-football.jpg'
        ];
      }
      payload.heroImages.push(url);
      if (!payload.heroImage) payload.heroImage = url;

      db.prepare('UPDATE site_documents SET payload = ?, updated_at = ? WHERE key = ?')
        .run(JSON.stringify(payload), ts, 'home');

      logAction(req.admin, 'Added', 'New image to section: ' + id);
      return res.json({ ok: true, url });
    }

    const targetCollection = COLLECTION_MAP[id];
    if (targetCollection) {
      const newId = crypto.randomUUID();
      const defaultTitle = 'New ' + (id === 'campus' || id === 'facilities' ? 'Facility' : (id === 'gallery' ? 'Photo' : (id === 'activities' ? 'Activity' : (id.charAt(0).toUpperCase() + id.slice(1))))) + ' Item';
      const defaultCat = id === 'sports' ? 'Sports' : (id === 'campus' || id === 'facilities' ? 'Facilities' : (id === 'gallery' ? 'Gallery' : (id === 'activities' ? 'Activities' : (id.charAt(0).toUpperCase() + id.slice(1)))));
      const payload = {
        title: defaultTitle,
        description: '',
        category: defaultCat,
        image: url,
        displayOrder: 99,
        published: true
      };
      db.prepare('INSERT INTO content_items (id, collection, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(newId, targetCollection, JSON.stringify(payload), ts, ts);
    } else {
      const docKey = SECTION_DOC_MAP[id] || id;
      const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ? OR key = ?').get(docKey, id);
      let payload = {};
      if (doc) {
        try { payload = JSON.parse(doc.payload); } catch { }
      }

      const field = id === 'about' ? 'photos' : 'images';
      if (!Array.isArray(payload[field])) payload[field] = [];
      payload[field].push(url);

      db.prepare('INSERT INTO site_documents (key, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at')
        .run(docKey, JSON.stringify(payload), ts);
    }

    logAction(req.admin, 'Added', 'New image to section: ' + id);
    res.json({ ok: true, url });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// 4. POST: Upload / Replace Image
app.post('/api/admin/sections/:id/images/:slotKey', privateApi, upload.single('image'), async (req, res, next) => {
  const { id, slotKey } = req.params;
  if (slotKey === 'add') return next();
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  try {
    const spec = getImageSpec(id, slotKey);
    const metadata = await sharp(req.file.buffer).metadata();

    if (metadata.width !== spec.width || metadata.height !== spec.height) {
      const expectedRatio = spec.width / spec.height;
      const actualRatio = metadata.width / metadata.height;
      const ratioDiff = Math.abs(expectedRatio - actualRatio) / expectedRatio;
      let isAllowed = ratioDiff <= 0.05;
      if (!isAllowed && (id === 'gallery' || id === 'photo-gallery' || id === 'activities')) {
        const ratioDiff32 = Math.abs(1.5 - actualRatio) / 1.5;
        if (ratioDiff32 <= 0.05) isAllowed = true;
      }
      if (!isAllowed) {
        return res.status(400).json({ 
          error: `Upload Failed – Image size must be ${spec.width} × ${spec.height} px (Ratio ${spec.width}:${spec.height}). Your image is ${metadata.width} × ${metadata.height} px.` 
        });
      }
    }

    const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;
    const outputPath = path.join(uploadDir, filename);
    await sharp(req.file.buffer).resize(spec.width, spec.height, { fit: 'cover' }).webp({ quality: 85 }).toFile(outputPath);
    const url = '/uploads/' + filename;
    const ts = new Date().toISOString();

    if (slotKey.startsWith('collection_')) {
      const itemId = slotKey.replace('collection_', '');
      const item = db.prepare('SELECT payload FROM content_items WHERE id = ?').get(itemId);
      if (item) {
        let itemPayload = {};
        try { itemPayload = JSON.parse(item.payload); } catch { }
        itemPayload.image = url;
        db.prepare('UPDATE content_items SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(itemPayload), ts, itemId);
      }
    } else {
      const docKey = SECTION_DOC_MAP[id] || id;
      const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ? OR key = ?').get(docKey, id);
      let payload = {};
      if (doc) {
        try { payload = JSON.parse(doc.payload); } catch { }
      }

      if (id === 'sports-academy' || id === 'sportsAcademy') {
        if (!Array.isArray(payload.sportsCards) || payload.sportsCards.length === 0) {
          payload.sportsCards = JSON.parse(JSON.stringify(defaultSportsCards));
        }
        if (!Array.isArray(payload.sliderImages) || payload.sliderImages.length === 0) {
          payload.sliderImages = JSON.parse(JSON.stringify(defaultSportsSliderImages));
        }

        if (slotKey === 'bannerImage') {
          payload.bannerImage = url;
        } else if (slotKey.startsWith('sportsCards_')) {
          const index = parseInt(slotKey.split('_')[1], 10);
          if (payload.sportsCards[index]) {
            payload.sportsCards[index].image = url;
          }
        } else if (slotKey.startsWith('sliderImages_')) {
          const index = parseInt(slotKey.split('_')[1], 10);
          if (payload.sliderImages) {
            payload.sliderImages[index] = url;
          }
        } else {
          payload[slotKey] = url;
        }
      } else if (id === 'way-we-work') {
          if (slotKey === 'curriculumImage' || slotKey.startsWith('curriculumImages_')) {
            payload.curriculumImage = url;
            if (!Array.isArray(payload.curriculumImages) || payload.curriculumImages.length === 0) {
              payload.curriculumImages = [url];
            } else {
              payload.curriculumImages[0] = url;
            }
          } else if (slotKey === 'extraCurricularImage') {
            payload.extraCurricularImage = url;
            payload.circularImage = url;
          } else if (slotKey === 'roboticsImage') {
            payload.roboticsImage = url;
            payload.studentImage = url;
          } else if (slotKey === 'marinersStarImage') {
            payload.marinersStarImage = url;
          } else {
            payload[slotKey] = url;
          }
        } else if (id === 'advisory-board') {
          if (slotKey.startsWith('advisors_')) {
            const idx = parseInt(slotKey.split('_')[1], 10);
            if (!Array.isArray(payload.advisors) || payload.advisors.length === 0) {
              payload.advisors = JSON.parse(JSON.stringify(defaultAdvisors));
            }
            if (payload.advisors[idx]) {
              payload.advisors[idx].image = url;
            }
          } else if (slotKey.startsWith('sliderImages_')) {
            const idx = parseInt(slotKey.split('_')[1], 10);
            if (!Array.isArray(payload.sliderImages) || payload.sliderImages.length === 0) {
              payload.sliderImages = [
                '/assets/images/interactive-digitized.jpg',
                '/assets/images/5-acre-campus-secured.jpg'
              ];
            }
            payload.sliderImages[idx] = url;
          } else {
            payload[slotKey] = url;
          }
        } else if (slotKey.includes('_')) {
          const [field, index] = slotKey.split('_');
          const idx = parseInt(index, 10);
          if (!Array.isArray(payload[field])) {
            if (field === 'heroImages') {
              payload.heroImages = [
                '/assets/images/campus-banner.webp',
                '/assets/images/5-acre-campus-secured.jpg',
                '/assets/images/interactive-digitized.jpg',
                '/assets/images/community-football.jpg'
              ];
            } else {
              payload[field] = [];
            }
          }
          payload[field][idx] = url;
          if (field === 'heroImages' && idx === 0) {
            payload.heroImage = url;
          }
        } else {
          payload[slotKey] = url;
          if (slotKey === 'heroImage') {
            if (!Array.isArray(payload.heroImages)) payload.heroImages = [];
            payload.heroImages[0] = url;
          }
        }

        db.prepare('INSERT INTO site_documents (key, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at')
          .run(docKey, JSON.stringify(payload), ts);
      }

      logAction(req.admin, 'Uploaded', 'Image for ' + id + ' (slot: ' + slotKey + ')');
      res.json({ ok: true, url });
    } catch (err) {
      res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
  });

// 5. DELETE: Delete Image
app.delete('/api/admin/sections/:id/images/:slotKey', privateApi, (req, res) => {
  const { id, slotKey } = req.params;
  const ts = new Date().toISOString();

  if (slotKey.startsWith('collection_')) {
    const itemId = slotKey.replace('collection_', '');
    const item = db.prepare('SELECT payload FROM content_items WHERE id = ?').get(itemId);
    if (item) {
      let itemPayload = {};
      try { itemPayload = JSON.parse(item.payload); } catch { }
      const oldUrl = itemPayload.image;
      if (oldUrl && typeof oldUrl === 'string' && oldUrl.startsWith('/uploads/')) {
        const filename = oldUrl.replace('/uploads/', '');
        const filePath = path.join(uploadDir, filename);
        if (fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch { }
        }
      }
      itemPayload.image = '';
      db.prepare('UPDATE content_items SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(itemPayload), ts, itemId);
    }
  } else {
    const docKey = SECTION_DOC_MAP[id] || id;
    const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ? OR key = ?').get(docKey, id);

    if (doc) {
      let payload = {};
      try { payload = JSON.parse(doc.payload); } catch { }
      let oldUrl = null;
      if (id === 'sports-academy' || id === 'sportsAcademy') {
        if (slotKey === 'bannerImage') {
          oldUrl = payload.bannerImage;
          payload.bannerImage = '';
        } else if (slotKey.startsWith('sportsCards_')) {
          const index = parseInt(slotKey.split('_')[1], 10);
          if (payload.sportsCards && payload.sportsCards[index]) {
            oldUrl = payload.sportsCards[index].image;
            payload.sportsCards[index].image = '';
          }
        } else if (slotKey.startsWith('sliderImages_')) {
          const index = parseInt(slotKey.split('_')[1], 10);
          if (payload.sliderImages && payload.sliderImages[index]) {
            oldUrl = payload.sliderImages[index];
            payload.sliderImages[index] = '';
          }
        } else {
          oldUrl = payload[slotKey];
          delete payload[slotKey];
        }
      } else if (id === 'way-we-work') {
          if (slotKey === 'curriculumImage' || slotKey.startsWith('curriculumImages_')) {
            oldUrl = payload.curriculumImage || (payload.curriculumImages && payload.curriculumImages[0]);
            delete payload.curriculumImage;
            if (Array.isArray(payload.curriculumImages)) {
              payload.curriculumImages[0] = '';
            }
          } else if (slotKey === 'extraCurricularImage') {
            oldUrl = payload.extraCurricularImage || payload.circularImage;
            delete payload.extraCurricularImage;
            delete payload.circularImage;
          } else if (slotKey === 'roboticsImage') {
            oldUrl = payload.roboticsImage || payload.studentImage;
            delete payload.roboticsImage;
            delete payload.studentImage;
          } else if (slotKey === 'marinersStarImage') {
            oldUrl = payload.marinersStarImage;
            delete payload.marinersStarImage;
          } else {
            oldUrl = payload[slotKey];
            delete payload[slotKey];
          }
        } else if (id === 'advisory-board') {
          if (slotKey.startsWith('advisors_')) {
            const idx = parseInt(slotKey.split('_')[1], 10);
            if (Array.isArray(payload.advisors) && payload.advisors[idx]) {
              oldUrl = payload.advisors[idx].image;
              payload.advisors[idx].image = '';
            }
          } else if (slotKey.startsWith('sliderImages_')) {
            const idx = parseInt(slotKey.split('_')[1], 10);
            if (Array.isArray(payload.sliderImages) && payload.sliderImages[idx]) {
              oldUrl = payload.sliderImages[idx];
              payload.sliderImages[idx] = '';
            }
          } else {
            oldUrl = payload[slotKey];
            delete payload[slotKey];
          }
        } else if (slotKey.includes('_')) {
          const [field, index] = slotKey.split('_');
          const idx = parseInt(index, 10);
          if (Array.isArray(payload[field])) {
            oldUrl = payload[field][idx];
            payload[field].splice(idx, 1);
            if (field === 'heroImages') {
              payload.heroImage = payload.heroImages[0] || '';
            }
          }
        } else {
          oldUrl = payload[slotKey];
          delete payload[slotKey];
          if (slotKey === 'heroImage') {
            payload.heroImage = '';
          }
        }

        if (oldUrl && typeof oldUrl === 'string' && oldUrl.startsWith('/uploads/')) {
          const filename = oldUrl.replace('/uploads/', '');
          const filePath = path.join(uploadDir, filename);
          if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch { }
          }
        }

        db.prepare('INSERT INTO site_documents (key, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at')
          .run(docKey, JSON.stringify(payload), ts);
      }
    }

    logAction(req.admin, 'Deleted', 'Image: ' + slotKey + ' from ' + id);
    res.json({ ok: true });
  });

// 6. ENQUIRIES: Delete Enquiry
app.delete('/api/admin/enquiries/:id', privateApi, (req, res) => {
  const { id: enquiryId } = req.params;
  db.prepare('DELETE FROM enquiries WHERE id = ?').run(enquiryId);
  logAction(req.admin, 'Deleted', 'Enquiry: ' + enquiryId);
  res.json({ ok: true });
});

// 7. MARQUEE: Get & Put
app.get('/api/admin/marquee', privateApi, (req, res) => {
  let doc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('sections');
  let payload = doc ? JSON.parse(doc.payload) : {};

  let items = [];

  // Check all possible keys where announcements might be stored
  if (Array.isArray(payload.marqueeItems) && payload.marqueeItems.length > 0) {
    items = payload.marqueeItems;
  } else if (Array.isArray(payload.announcements) && payload.announcements.length > 0) {
    items = payload.announcements.map(text => (typeof text === 'string' ? { text, enabled: true } : text));
  } else if (payload.marqueeText) {
    items = [{ text: payload.marqueeText, enabled: true }];
  } else {
    // If the database is completely empty, create a default one and SAVE it
    items = [
      { text: 'Admissions open for 2026-27!', enabled: true },
      { text: 'Annual Sports Day scheduled for next Friday.', enabled: true }
    ];
    payload.marqueeItems = items;
    if (!doc) {
      db.prepare('INSERT INTO site_documents (key, payload, updated_at) VALUES (?, ?, ?)').run('sections', JSON.stringify(payload), new Date().toISOString());
    } else {
      db.prepare('UPDATE site_documents SET payload = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(payload), new Date().toISOString(), 'sections');
    }
  }

  res.json({
    enabled: payload.marqueeEnabled !== false,
    speed: payload.marqueeSpeed || 20,
    startDate: payload.marqueeStart || '',
    endDate: payload.marqueeEnd || '',
    items: items
  });
});

app.put('/api/admin/marquee', privateApi, (req, res) => {
  const doc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('sections');
  if (doc) {
    const payload = JSON.parse(doc.payload);
    payload.marqueeEnabled = req.body.enabled;
    payload.marqueeSpeed = req.body.speed;
    payload.marqueeStart = req.body.startDate;
    payload.marqueeEnd = req.body.endDate;

    // Save the array of items
    if (req.body.items && Array.isArray(req.body.items)) {
      payload.marqueeItems = req.body.items;
      // Keep marqueeText updated for index.html compatibility
      payload.marqueeText = req.body.items.filter(i => i.enabled).map(i => i.text).join(' • ');
    }

    db.prepare('UPDATE site_documents SET payload = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(payload), new Date().toISOString(), 'sections');

    // Also sync to home
    const homeDoc = db.prepare('SELECT payload FROM site_documents WHERE key = ?').get('home');
    if (homeDoc) {
      const homePayload = JSON.parse(homeDoc.payload) || {};
      homePayload.marqueeEnabled = payload.marqueeEnabled;
      homePayload.marqueeSpeed = payload.marqueeSpeed;
      homePayload.marqueeStart = payload.marqueeStart;
      homePayload.marqueeEnd = payload.marqueeEnd;
      homePayload.marqueeItems = payload.marqueeItems;
      homePayload.marqueeText = payload.marqueeText;
      db.prepare('UPDATE site_documents SET payload = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(homePayload), new Date().toISOString(), 'home');
    }

    // Also sync to cms_marquees
    try {
      db.prepare('DELETE FROM cms_marquees').run();
      const insertMarquee = db.prepare(`
        INSERT INTO cms_marquees (id, section_id, text, direction, speed_seconds, display_order, is_active, start_date, expiry_date, created_at, updated_at)
        VALUES (?, 'notice_marquee', ?, 'ltr', ?, ?, ?, ?, ?, ?, ?)
      `);
      (payload.marqueeItems || []).forEach((item, idx) => {
        insertMarquee.run(
          crypto.randomUUID(),
          item.text,
          payload.marqueeSpeed || 20,
          (idx + 1) * 10,
          item.enabled ? 1 : 0,
          payload.marqueeStart || null,
          payload.marqueeEnd || null,
          new Date().toISOString(),
          new Date().toISOString()
        );
      });
    } catch { }
  }
  logAction(req.admin, 'Updated', 'Marquee settings');
  res.json({ ok: true });
});

// 8. PDF: Upload
app.post('/api/admin/sections/:id/pdfs', privateApi, upload.single('pdf'), (req, res) => {
  if (!req.file || req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Please upload a PDF.' });
  const filename = 'doc-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.pdf';
  const filePath = path.join(uploadDir, filename);
  fs.writeFileSync(filePath, req.file.buffer);
  const url = '/uploads/' + filename;
  logAction(req.admin, 'Uploaded', 'PDF: ' + req.file.originalname + ' for ' + req.params.id);
  res.json({ ok: true, url, title: req.file.originalname || filename });
});


app.use('/api/*', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 40 MB upload limit.' : 'The upload could not be processed.' });
  if (error) {
    console.error('Request failed:', error.message);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'The server could not process this request.' });
  }
});
app.listen(port, () => {
  const listenTarget = typeof port === 'string' ? port : `http://localhost:${port}`;
  console.log(`ENPEE CMS listening on ${listenTarget}`);
});
