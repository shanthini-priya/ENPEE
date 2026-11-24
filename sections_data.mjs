import fs from 'fs';

// Define the comprehensive 14 actual sections matching index.html
export const all14Sections = [
  {
    id: 'top_header',
    name: 'Top Header & Utility Bar',
    description: 'Header phone numbers, admissions enquiry hotlines, email, school campus address, and social links.',
    category: 'Header',
    display_order: 10,
    blocks: [
      { key: 'phone', label: 'Landline Number', type: 'text', val: '04368 265 265' },
      { key: 'mobile', label: 'Mobile / WhatsApp Hotlines', type: 'text', val: '+91 8300 111 265' },
      { key: 'email', label: 'Official School Email', type: 'text', val: 'info@enpeekkl.com' },
      { key: 'affiliation', label: 'CBSE Affiliation Info', type: 'text', val: 'CBSE Affiliation No. 2930085' },
      { key: 'schoolHours', label: 'School Office Hours', type: 'text', val: 'Mon – Sat: 8:30 AM – 5:00 PM' }
    ],
    requirements: [
      { slot: 'header_logo', label: 'Header School Emblem', min_w: 200, max_w: 1200, min_h: 80, max_h: 600, exact_w: 500, exact_h: 500, aspect_ratio: '1:1', max_kb: 2048, allowed_formats: 'png,webp', help: 'Transparent official school crest.' }
    ],
    images: [
      { slot: 'header_logo', url: 'assets/images/logo/enpee-logo.webp', name: 'enpee-logo.webp', w: 500, h: 500 }
    ],
    marquees: []
  },
  {
    id: 'navigation_bar',
    name: 'Main Navigation Bar',
    description: 'Main navigation menus, submenus, dropdown items, quick action buttons, and admissions CTA.',
    category: 'Header',
    display_order: 20,
    blocks: [
      { key: 'ctaText', label: 'Nav Enquire Button Text', type: 'text', val: 'Enquire Now' },
      { key: 'ctaLink', label: 'Nav Enquire Button Link', type: 'text', val: '#admissions' }
    ],
    requirements: [
      { slot: 'nav_brand_logo', label: 'Navigation Brand Logo', min_w: 300, max_w: 1600, min_h: 100, max_h: 800, exact_w: 500, exact_h: 500, aspect_ratio: '1:1', max_kb: 2048, allowed_formats: 'png,webp', help: 'Official high-resolution navigation logo.' }
    ],
    images: [
      { slot: 'nav_brand_logo', url: 'assets/images/logo/enpee-logo.webp', name: 'enpee-logo.webp', w: 500, h: 500 }
    ],
    marquees: []
  },
  {
    id: 'notice_marquee',
    name: 'Notice Marquee & Announcements',
    description: 'Top scrolling announcements ticker bar with speed controls, pause-on-hover, and live website links.',
    category: 'Announcements',
    display_order: 30,
    blocks: [
      { key: 'marqueeBadge', label: 'Ticker Badge Text', type: 'text', val: 'LATEST' },
      { key: 'marqueeSpeed', label: 'Scroll Speed Seconds', type: 'number', val: '22' }
    ],
    requirements: [],
    images: [],
    marquees: [
      { text: 'Admissions Open for Academic Year 2026–27 (Pre-KG to Class IX) • CBSE Affiliated School · Affiliation No. 2930085 • 5-Acre Eco-Friendly Château Français Campus, Karaikal • ENPEE Sports Academy & Smart Digitized Classrooms • Campus Visits & Enquiries: 04368 265 265 · +91 8300 111 265', link: '#admissions', speed: 22, bg: '#F4F8FD', text_col: '#1E61AC', dir: 'ltr' }
    ]
  },
  {
    id: 'hero_section',
    name: 'Homepage Hero & Panoramic Banner',
    description: 'Ultra-wide landscape hero banner (3.3:1 aspect ratio), headline, welcoming taglines, and call to action buttons.',
    category: 'Homepage',
    display_order: 40,
    blocks: [
      { key: 'heroTagline', label: 'Hero Tagline', type: 'text', val: 'CBSE SCHOOL | KARAIKAL' },
      { key: 'heroEyebrow', label: 'Hero Eyebrow', type: 'text', val: 'Karaikal’s 1st Premium School · CBSE Aff. No. 2930085' },
      { key: 'heroHeading', label: 'Hero Heading', type: 'text', val: 'Where Young Minds Grow Into Extraordinary Futures.' },
      { key: 'heroDescription', label: 'Hero Description', type: 'textarea', val: 'A world-class CBSE education in Karaikal empowering holistic academic excellence, character development, and cultural roots.' },
      { key: 'heroPrimaryText', label: 'Primary CTA Text', type: 'text', val: 'Explore Our School' },
      { key: 'heroPrimaryLink', label: 'Primary CTA Link', type: 'text', val: '#about' },
      { key: 'heroSecondaryText', label: 'Secondary CTA Text', type: 'text', val: 'Admission Open – Enquire Now' },
      { key: 'heroSecondaryLink', label: 'Secondary CTA Link', type: 'text', val: '#admissions' }
    ],
    requirements: [
      { slot: 'hero_panoramic', label: 'Hero Panoramic Banner', min_w: 1200, max_w: 3840, min_h: 400, max_h: 1600, exact_w: 1920, exact_h: 650, aspect_ratio: '16:9', max_kb: 5120, allowed_formats: 'jpg,jpeg,png,webp', help: 'Ultra-wide 1920x650px panoramic hero banner.' }
    ],
    images: [
      { slot: 'hero_panoramic', url: 'assets/images/campus-banner.webp', name: 'campus-banner.webp', w: 1920, h: 650 }
    ],
    marquees: []
  },
  {
    id: 'about_school',
    name: 'About the School',
    description: 'Historical foundation, architectural ethos, core values, institutional pillars, and accreditation.',
    category: 'About',
    display_order: 50,
    blocks: [
      { key: 'aboutEyebrow', label: 'Section Eyebrow', type: 'text', val: 'About ENPEE International School' },
      { key: 'aboutHeading', label: 'Main Heading', type: 'text', val: 'A Legacy of Inspired Learning & Character' },
      { key: 'introduction', label: 'Detailed Introduction', type: 'rich_text', val: '<p>ENPEE International School was founded with a singular visionary ideal: to offer children in Karaikal an environment where traditional cultural values meet 21st-century global educational standards.</p>' },
      { key: 'history', label: 'School History & Growth', type: 'textarea', val: 'Established under the ENPEE Educational Trust, the institution has continually upgraded its facilities, digitized classrooms, and holistic co-curricular offerings.' }
    ],
    requirements: [
      { slot: 'about_campus_photo', label: 'About Campus Architecture', min_w: 1000, max_w: 2400, min_h: 600, max_h: 1600, exact_w: 1200, exact_h: 800, aspect_ratio: '3:2', max_kb: 4096, allowed_formats: 'jpg,jpeg,png,webp', help: 'Main scenic photo of the school campus (1200x800px).' }
    ],
    images: [
      { slot: 'about_campus_photo', url: 'assets/images/school-img.jpg', name: 'school-img.jpg', w: 1200, h: 800 }
    ],
    marquees: []
  },
  {
    id: 'campus_highlights',
    name: 'Campus Highlights & Architecture',
    description: 'Château Français French-colonial eco-campus, 5-acre perimeter, outdoor quadrangles, and security features.',
    category: 'Campus',
    display_order: 60,
    blocks: [
      { key: 'campusEyebrow', label: 'Campus Eyebrow', type: 'text', val: 'Château Français Campus' },
      { key: 'campusHeading', label: 'Campus Heading', type: 'text', val: 'A 5-Acre French-Colonial Inspired Eco-Campus' },
      { key: 'campusDescription', label: 'Campus Description', type: 'textarea', val: 'Purpose-built to inspire curiosity, creativity, and calm focus in Karaikal with lush gardens, courtyards, and high-ceiling verandas.' }
    ],
    requirements: [
      { slot: 'campus_secured_view', label: 'Secured Campus View', min_w: 1000, max_w: 2400, min_h: 600, max_h: 1600, exact_w: 1200, exact_h: 800, aspect_ratio: '3:2', max_kb: 4096, allowed_formats: 'jpg,jpeg,png,webp', help: '5-Acre secured perimeter shot.' }
    ],
    images: [
      { slot: 'campus_secured_view', url: 'assets/images/5-acre-campus-secured.jpg', name: '5-acre-campus-secured.jpg', w: 1200, h: 800 }
    ],
    marquees: []
  },
  {
    id: 'academic_programmes',
    name: 'Academic Programmes',
    description: 'Developmentally Appropriate Practice (DAP), Pre-KG, Primary, Middle School CBSE curriculum and pedagogy.',
    category: 'Academics',
    display_order: 70,
    blocks: [
      { key: 'academicsEyebrow', label: 'Academics Eyebrow', type: 'text', val: 'Academic Programmes' },
      { key: 'academicsHeading', label: 'Academics Heading', type: 'text', val: 'Developmentally Appropriate Practice (DAP)' },
      { key: 'academicsDescription', label: 'Curriculum Description', type: 'textarea', val: 'A balanced framework designed to promote young children’s optimal learning and development through a strengths-based, play-based approach.' }
    ],
    requirements: [
      { slot: 'academics_banner', label: 'Academics Classroom Photo', min_w: 1000, max_w: 2400, min_h: 600, max_h: 1600, exact_w: 1200, exact_h: 800, aspect_ratio: '3:2', max_kb: 4096, allowed_formats: 'jpg,jpeg,png,webp', help: 'Engaged classroom learning photo.' }
    ],
    images: [
      { slot: 'academics_banner', url: 'assets/images/carosel/003.jpg', name: '003.jpg', w: 1200, h: 800 }
    ],
    marquees: []
  },
  {
    id: 'facilities',
    name: 'Facilities & Infrastructure',
    description: 'Digitized smart classrooms, modern science laboratories, library resource centre, and air-conditioned buses.',
    category: 'Facilities',
    display_order: 80,
    blocks: [
      { key: 'facilitiesEyebrow', label: 'Facilities Eyebrow', type: 'text', val: 'Campus Facilities' },
      { key: 'facilitiesHeading', label: 'Facilities Heading', type: 'text', val: 'World-Class Learning Infrastructure' },
      { key: 'facilitiesDescription', label: 'Facilities Description', type: 'textarea', val: 'Digitized touch-enabled smart interactive boards, equipped physics, chemistry, biology and robotics laboratories, and safe transport.' }
    ],
    requirements: [
      { slot: 'smart_classrooms', label: 'Smart Classrooms Photo', min_w: 1000, max_w: 2400, min_h: 600, max_h: 1600, exact_w: 1200, exact_h: 800, aspect_ratio: '3:2', max_kb: 4096, allowed_formats: 'jpg,jpeg,png,webp', help: 'Interactive digitized classroom.' },
      { slot: 'transport_fleet', label: 'Transport Fleet Buses', min_w: 1000, max_w: 2400, min_h: 600, max_h: 1600, exact_w: 1200, exact_h: 800, aspect_ratio: '3:2', max_kb: 4096, allowed_formats: 'jpg,jpeg,png,webp', help: 'Air-conditioned GPS buses.' }
    ],
    images: [
      { slot: 'smart_classrooms', url: 'assets/images/interactive-digitized.jpg', name: 'interactive-digitized.jpg', w: 1200, h: 800 },
      { slot: 'transport_fleet', url: 'assets/images/carosel/air-buses.jpg', name: 'air-buses.jpg', w: 1200, h: 800 }
    ],
    marquees: []
  },
  {
    id: 'activities',
    name: 'Student Activities & Clubs',
    description: 'Co-curricular activities, visual arts, music, dance, robotics tinkering, eco-club, and leadership squads.',
    category: 'Activities',
    display_order: 90,
    blocks: [
      { key: 'activitiesEyebrow', label: 'Activities Eyebrow', type: 'text', val: 'Student Activities' },
      { key: 'activitiesHeading', label: 'Activities Heading', type: 'text', val: 'Beyond the Classroom' },
      { key: 'activitiesDescription', label: 'Activities Description', type: 'textarea', val: 'Nurturing curiosity, creative expression, cultural appreciation, and collaborative leadership through a vibrant spectrum of clubs.' }
    ],
    requirements: [
      { slot: 'robotics_lab', label: 'Robotics & STEM Tinkering', min_w: 1000, max_w: 2400, min_h: 600, max_h: 1600, exact_w: 1200, exact_h: 800, aspect_ratio: '3:2', max_kb: 4096, allowed_formats: 'jpg,jpeg,png,webp', help: 'Robotics lab activities photo.' }
    ],
    images: [
      { slot: 'robotics_lab', url: 'assets/images/carosel/009.jpg', name: '009.jpg', w: 1200, h: 800 }
    ],
    marquees: []
  },
  {
    id: 'sports',
    name: 'Sports Academy',
    description: 'Roller-skating rink, Olympic archery range, track & field, basketball, and competitive football field.',
    category: 'Sports',
    display_order: 100,
    blocks: [
      { key: 'sportsEyebrow', label: 'Sports Eyebrow', type: 'text', val: 'ENPEE Sports Academy' },
      { key: 'sportsHeading', label: 'Sports Heading', type: 'text', val: 'Athletic Excellence & Sportsmanship' },
      { key: 'sportsDescription', label: 'Sports Description', type: 'textarea', val: 'Cultivating athletic talent, endurance, sportsmanship, and leadership under certified physical education coaches.' }
    ],
    requirements: [
      { slot: 'sports_football', label: 'Sports Field & Football Ground', min_w: 1000, max_w: 2400, min_h: 600, max_h: 1600, exact_w: 1200, exact_h: 800, aspect_ratio: '3:2', max_kb: 4096, allowed_formats: 'jpg,jpeg,png,webp', help: 'Full-sized outdoor football and sports field.' }
    ],
    images: [
      { slot: 'sports_football', url: 'assets/images/community-football.jpg', name: 'community-football.jpg', w: 1200, h: 800 }
    ],
    marquees: []
  },
  {
    id: 'gallery',
    name: 'Moments at ENPEE Photo Gallery',
    description: 'Categorized photo gallery (Campus, Learning, Sports, Events) with responsive cards and full-screen lightbox.',
    category: 'Gallery',
    display_order: 110,
    blocks: [
      { key: 'galleryEyebrow', label: 'Gallery Eyebrow', type: 'text', val: 'Campus Life' },
      { key: 'galleryHeading', label: 'Gallery Heading', type: 'text', val: 'Moments at ENPEE' },
      { key: 'galleryDescription', label: 'Gallery Subtitle', type: 'textarea', val: 'Explore learning, activities, and school life across our campus.' }
    ],
    requirements: [
      { slot: 'gallery_annual_day', label: 'Annual Day Celebrations', min_w: 1000, max_w: 2400, min_h: 600, max_h: 1600, exact_w: 1200, exact_h: 800, aspect_ratio: '3:2', max_kb: 4096, allowed_formats: 'jpg,jpeg,png,webp', help: 'Grand stage performances and celebrations.' }
    ],
    images: [
      { slot: 'gallery_annual_day', url: 'assets/images/first-annual-day-celebration.jpeg', name: 'first-annual-day-celebration.jpeg', w: 1200, h: 800 }
    ],
    marquees: []
  },
  {
    id: 'video_gallery',
    name: 'Video Gallery',
    description: 'YouTube video feature carousel and interactive media player highlighting school events and student life.',
    category: 'Media',
    display_order: 120,
    blocks: [
      { key: 'videoEyebrow', label: 'Video Eyebrow', type: 'text', val: 'Video Showcase' },
      { key: 'videoHeading', label: 'Video Heading', type: 'text', val: 'Watch ENPEE in Motion' },
      { key: 'videoDescription', label: 'Video Description', type: 'textarea', val: 'Experience our vibrant academic culture, annual celebrations, and student presentations.' }
    ],
    requirements: [
      { slot: 'video_thumb_1', label: 'Featured Video Thumbnail', min_w: 1000, max_w: 2400, min_h: 500, max_h: 1500, exact_w: 1280, exact_h: 720, aspect_ratio: '16:9', max_kb: 4096, allowed_formats: 'jpg,jpeg,png,webp', help: 'High-definition 1280x720 video poster.' }
    ],
    images: [
      { slot: 'video_thumb_1', url: 'assets/images/video-thumbnails/51JIyUQ92BM.jpg', name: '51JIyUQ92BM.jpg', w: 1280, h: 720 }
    ],
    marquees: []
  },
  {
    id: 'school_philosophy',
    name: 'Our Educational Philosophy',
    description: 'Core institutional pillars: Knowledge | Innovation | Excellence and character-building framework.',
    category: 'About',
    display_order: 130,
    blocks: [
      { key: 'philEyebrow', label: 'Philosophy Eyebrow', type: 'text', val: 'Our Educational Philosophy' },
      { key: 'philHeading', label: 'Three Pillars', type: 'text', val: 'KNOWLEDGE | INNOVATION | EXCELLENCE' },
      { key: 'philDescription', label: 'Philosophy Statement', type: 'textarea', val: 'The core values that guide every classroom, every activity, and every child at ENPEE.' }
    ],
    requirements: [],
    images: [],
    marquees: []
  },
  {
    id: 'footer',
    name: 'Footer Section & Partners',
    description: 'School campus address, contact details, CBSE affiliation information, quick navigation links, and partner logos.',
    category: 'Footer',
    display_order: 140,
    blocks: [
      { key: 'schoolName', label: 'School Name', type: 'text', val: 'ENPEE International School' },
      { key: 'address', label: 'Campus Address', type: 'textarea', val: 'Château Français, ENPEE Enclave, 241/2, Puthakudy Village, Vadamattam Main Road, Nedungadu Panchayat, Karaikal – 609609, U.T. of Puducherry.' },
      { key: 'phone', label: 'Landline Phone', type: 'text', val: '04368 265 265' },
      { key: 'mobile', label: 'Mobile Hotline', type: 'text', val: '+91 8300 111 265' },
      { key: 'email', label: 'Official Email', type: 'text', val: 'info@enpeekkl.com' },
      { key: 'copyright', label: 'Copyright Notice', type: 'text', val: '© 2026 ENPEE International School. All Rights Reserved.' }
    ],
    requirements: [
      { slot: 'footer_logo', label: 'Footer Logo Emblem', min_w: 300, max_w: 1600, min_h: 100, max_h: 800, exact_w: 500, exact_h: 500, aspect_ratio: '1:1', max_kb: 2048, allowed_formats: 'png,webp', help: 'Footer transparent logo badge.' }
    ],
    images: [
      { slot: 'footer_logo', url: 'assets/images/logo/enpee-logo.webp', name: 'enpee-logo.webp', w: 500, h: 500 }
    ],
    marquees: []
  }
];
