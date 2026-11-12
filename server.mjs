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
const port = Number(process.env.PORT || 3000);
const dbPath = path.resolve(root, process.env.DB_PATH || './data/enpee.sqlite');
const uploadDir = path.resolve(root, process.env.UPLOAD_DIR || './uploads');
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters.');
}
if (process.env.PUBLIC_ORIGIN) {
  const publicOrigin = new URL(process.env.PUBLIC_ORIGIN);
  if (!['http:', 'https:'].includes(publicOrigin.protocol)) throw new Error('PUBLIC_ORIGIN must use HTTP or HTTPS.');
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
`);
if (!db.pragma('table_info(enquiries)').some((column) => column.name === 'previous_school')) {
  db.exec("ALTER TABLE enquiries ADD COLUMN previous_school TEXT NOT NULL DEFAULT ''");
}

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const slugify = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const contentSlug = (title, recordId) => `${slugify(title)}-${String(recordId).slice(0, 8)}`;
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
      'https://www.enpeekkl.com/images/5-acre-campus-secured.jpg',
      'https://www.enpeekkl.com/images/carosel/003.jpg'
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
          ? { title, description: second, category: imageOrCategory, classLevel: title, eligibility: '', image: [
            'https://www.enpeekkl.com/images/pic-pre-kg.jpg',
            'https://www.enpeekkl.com/images/pic-lkg-ukg.jpg',
            'https://www.enpeekkl.com/images/pic-class-one-five.jpg'
          ][index], displayOrder: index + 1, published: true }
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
    addIfMissing('youtubeVideos', { ...video, videoId, image: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, published: true });
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

app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
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
app.use('/uploads', express.static(uploadDir, { index: false, dotfiles: 'deny', maxAge: '0', setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));
app.get('/assets/lottie.min.js', (_req, res) => res.sendFile(path.join(root, 'node_modules', 'lottie-web', 'build', 'player', 'lottie.min.js')));
app.use('/assets', express.static(path.join(root, 'assets'), { index: false, dotfiles: 'deny', maxAge: '1h', setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));
app.get('/admin', (_req, res) => res.sendFile(path.join(root, 'admin.html')));
app.get('/admin/*path', (_req, res) => res.sendFile(path.join(root, 'admin.html')));
const publicPage = path.join(root, 'ENPEE International School, Karaikal – CBSE School.html');
app.get('/', (_req, res) => res.sendFile(publicPage));
const publicPageRoutes = [
  { path: '/about', key: 'about' },
  { path: '/promoters', key: 'promoters' },
  { path: '/management', key: 'management' },
  { path: '/chateau-francais', key: 'chateauFrancais' },
  { path: '/way-we-work', key: 'wayWeWork' },
  { path: '/programs-offered', key: 'programsOffered' },
  { path: '/what-makes-us-different', key: 'whatMakesUsDifferent' },
  { path: '/contact-us', key: 'contactUs' }
];
for (const [source, destination] of [
  ['/index.php', '/'],
  ['/about.php', '/about'],
  ['/promoters.php', '/promoters'],
  ['/management.php', '/management'],
  ['/advisory-board.php', '/management#advisory-board'],
  ['/chateau-francais.php', '/chateau-francais'],
  ['/way-we-work.php', '/way-we-work'],
  ['/programs-offered.php', '/programs-offered'],
  ['/what-makes-different.php', '/what-makes-us-different'],
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
    if (!page || !page.published) return res.status(404).sendFile(publicPage);
    fs.promises.readFile(publicPage, 'utf8').then((html) => {
      const title = `${page.title} | ENPEE International School`;
      const description = String(page.description || page.title).slice(0, 160);
      const canonical = `${process.env.PUBLIC_ORIGIN || `http://localhost:${port}`}${route.path}`;
      const rendered = html
        .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
        .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escapeHtml(description)}">`)
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
      .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escapeHtml(description)}">`);
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
  ,videoUrl: (v) => {
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
    if (!payload.image) payload.image = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
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
  res.json({ documents, collections });
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
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined
  });
  try {
    await transporter.sendMail({ from: process.env.SMTP_FROM, to: admin.email, subject: 'ENPEE CMS password reset',
      text: `Use this link within 30 minutes to reset your ENPEE CMS password:\n${origin}/admin/reset?token=${raw}` });
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
  const counts = {
    enquiries: db.prepare('SELECT COUNT(*) AS count FROM enquiries').get().count,
    newEnquiries: db.prepare("SELECT COUNT(*) AS count FROM enquiries WHERE status='New' AND type='Admission'").get().count,
    programs: db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE collection='programs'").get().count,
    gallery: db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE collection='gallery'").get().count + db.prepare('SELECT COUNT(*) AS count FROM media').get().count,
    announcements: db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE collection='announcements'").get().count
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
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'video/mp4', 'video/webm'];
    const supported = allowed.includes(file.mimetype);
    const error = supported ? null : Object.assign(new Error('Only JPEG, PNG, WebP, AVIF, MP4 and WebM files are supported.'), { status: 400 });
    callback(error, supported);
  }
});
app.use('/api/admin/media', rateLimit({ windowMs: 60 * 60 * 1000, limit: 50, standardHeaders: 'draft-8', legacyHeaders: false, handler: limitResponse }));
app.get('/api/admin/media', privateApi, (req, res) => {
  const query = `%${String(req.query.q || '').slice(0, 80)}%`;
  res.json(db.prepare('SELECT * FROM media WHERE original_name LIKE ? OR category LIKE ? ORDER BY created_at DESC LIMIT 200').all(query, query));
});
async function processMediaFile(file) {
  let buffer = file.buffer;
  let mimeType = file.mimetype;
  try {
    if (mimeType.startsWith('image/')) {
      const image = sharp(buffer, { limitInputPixels: 40000000 });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || metadata.width > 10000 || metadata.height > 10000) throw new Error('Image dimensions are too large or invalid.');
      buffer = await image.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, effort: 5 }).toBuffer();
      mimeType = 'image/webp';
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
  const processed = await processMediaFile(req.file);
  const ext = processed.mimeType === 'image/webp' ? '.webp' : processed.mimeType === 'video/mp4' ? '.mp4' : '.webm';
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
  const processed = await processMediaFile(req.file);
  if (processed.mimeType !== item.mime_type) return res.status(400).json({ error: 'The replacement must use the same media type so existing website references remain valid.' });
  fs.writeFileSync(path.join(uploadDir, item.filename), processed.buffer);
  db.prepare('UPDATE media SET original_name=?,size=? WHERE id=?')
    .run(req.file.originalname.slice(0, 200), processed.buffer.length, item.id);
  logAction(req.admin, 'Replaced', `Media: ${item.original_name}`);
  res.json({ id: item.id, filename: item.filename, url: `/uploads/${item.filename}`, mime_type: item.mime_type, size: processed.buffer.length, category: item.category });
});
app.delete('/api/admin/media/:id', privateApi, (req, res) => {
  const item = db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Media item not found.' });
  const references = db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE payload LIKE ?").get(`%/uploads/${item.filename}%`).count;
  const documentReferences = db.prepare("SELECT COUNT(*) AS count FROM site_documents WHERE payload LIKE ?").get(`%/uploads/${item.filename}%`).count;
  if (references || documentReferences) return res.status(409).json({ error: 'This file is referenced by website content. Replace or remove those references first.' });
  db.prepare('DELETE FROM media WHERE id=?').run(item.id);
  fs.rmSync(path.join(uploadDir, item.filename), { force: true });
  logAction(req.admin, 'Deleted', `Media: ${item.original_name}`);
  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 40 MB upload limit.' : 'The upload could not be processed.' });
  if (error) {
    console.error('Request failed:', error.message);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'The server could not process this request.' });
  }
});
app.listen(port, () => console.log(`ENPEE CMS listening on http://localhost:${port}`));
