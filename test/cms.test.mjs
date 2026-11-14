import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import test from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('CMS authentication, persistence, content publishing, enquiries, and media', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'enpee-cms-test-'));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const adminEmail = 'admin@enpee.test';
  const adminPassword = 'A-secure-test-password-2026';
  const updatedPassword = 'Updated-Secure-password-2026';
  const expectedStatistics = [
    { title: 'CBSE Curriculum', detail: 'NCERT-based holistic learning' },
    { title: 'Smart Classrooms', detail: 'Interactive digitized learning' },
    { title: '5-Acre Campus', detail: 'Lush green, eco-friendly & secure environment' },
    { title: 'Sports Academy', detail: 'Professional coaching & performance assessment' }
  ];
  let child;
  let output = '';
  const legacyDatabase = new Database(path.join(temp, 'cms.sqlite'));
  legacyDatabase.exec(`CREATE TABLE enquiries (
    id TEXT PRIMARY KEY, parent_name TEXT NOT NULL, student_name TEXT NOT NULL,
    mobile TEXT NOT NULL, email TEXT NOT NULL, applying_class TEXT NOT NULL,
    academic_year TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'Admission',
    status TEXT NOT NULL DEFAULT 'New', internal_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE media (
    id TEXT PRIMARY KEY, filename TEXT NOT NULL, original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL, size INTEGER NOT NULL, category TEXT NOT NULL DEFAULT 'General',
    created_at TEXT NOT NULL
  )`);
  const uploadedLogo = await sharp({ create: { width: 4, height: 2, channels: 3, background: '#193B57' } }).webp().toBuffer();
  fs.mkdirSync(path.join(temp, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'uploads', 'previously-uploaded-logo.webp'), uploadedLogo);
  legacyDatabase.prepare(`INSERT INTO media(id,filename,original_name,mime_type,size,category,created_at)
    VALUES(?,?,?,?,?,?,?)`).run('existing-logo-media', 'previously-uploaded-logo.webp', 'ENPEE International School Logo.png', 'image/webp', uploadedLogo.length, 'School logo', new Date().toISOString());
  legacyDatabase.close();

  async function startServer() {
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        PUBLIC_ORIGIN: origin,
        ADMIN_EMAIL: adminEmail,
        ADMIN_PASSWORD: adminPassword,
        SESSION_SECRET: 'test-session-secret-with-more-than-32-characters',
        DB_PATH: path.join(temp, 'cms.sqlite'),
        UPLOAD_DIR: path.join(temp, 'uploads')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`CMS server exited: ${output}`);
      try {
        const response = await fetch(`${origin}/api/public/content`);
        if (response.ok) return;
      } catch {}
      await delay(100);
    }
    throw new Error(`CMS server did not start: ${output}`);
  }

  async function stopServer() {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), delay(5000)]);
    }
  }

  async function request(url, options = {}) {
    const response = await fetch(`${origin}${url}`, options);
    const data = (response.headers.get('content-type') || '').includes('application/json')
      ? await response.json()
      : await response.text();
    return { response, data };
  }

  try {
    await startServer();

    const adminPage = await request('/admin');
    assert.equal(adminPage.response.status, 200);
    assert.match(adminPage.data, /ENPEE CMS/);
    assert.doesNotMatch(adminPage.data, /id="page-title"|['"]#page-title['"]/, 'the shared admin layout does not duplicate tab titles');
    const navigation = adminPage.data.match(/const navItems = \[([\s\S]*?)\];/)?.[1];
    assert.ok(navigation, 'simple admin navigation is present');
    assert.equal((navigation.match(/\['/g) || []).length, 24, 'admin navigation exposes all editable website sections');
    assert.doesNotMatch(adminPage.data, /\sonclick=/i, 'admin actions use listeners compatible with the content security policy');
    assert.match(adminPage.data, /item\.previous_school\|\|'—'/, 'admission details display the previous school');
    assert.match(adminPage.data, /fieldHtml\('logoImage','School logo image'/, 'change photos includes a school logo upload field');
    assert.match(adminPage.data, /marqueeEnabled.*Show announcement marquee/, 'homepage editor can enable or disable the marquee');
    assert.match(adminPage.data, /school-content-select/, 'school content sections are available through the in-page picker');
    assert.match(adminPage.data, /renderSectionEditor/, 'static website section copy has a dedicated CMS editor');
    assert.match(adminPage.data, /renderNavigationEditor/, 'website navigation has a dedicated CMS editor');
    assert.match(adminPage.data, /features:\[\['title','Feature heading'/, 'feature cards can be managed in the CMS');
    assert.match(adminPage.data, /testimonials:\[\['title','Testimonial label'/, 'testimonials can be managed and approved in the CMS');
    assert.match(adminPage.data, /hiddenByDefault=\[[^\]]*'testimonials'[^\]]*\]/, 'new testimonials start unpublished until reviewed');
    const renderers = [
      ['document tabs', adminPage.data.slice(adminPage.data.lastIndexOf('async function renderDocument('), adminPage.data.lastIndexOf('async function renderPhotos(')), true],
      ['photo tab', adminPage.data.slice(adminPage.data.lastIndexOf('async function renderPhotos('), adminPage.data.lastIndexOf('function renderCollection(')), true],
      ['content tabs', adminPage.data.slice(adminPage.data.lastIndexOf('async function renderSimpleCollection('), adminPage.data.lastIndexOf('function bindGalleryUpload(')), true],
      ['enquiry tab', adminPage.data.slice(adminPage.data.lastIndexOf('async function renderEnquiries('), adminPage.data.lastIndexOf('window.completeEnquiry=')), false]
    ];
    for (const [name, renderer, hasPreview] of renderers) {
      assert.equal((renderer.match(/class="section-heading"/g) || []).length, 1, `${name} has one page header`);
      assert.equal((renderer.match(/<h2>/g) || []).length, 1, `${name} has one page title`);
      const headingStart = renderer.indexOf('class="section-heading"');
      const formStart = renderer.indexOf('<form', headingStart);
      const toolbarStart = renderer.indexOf('class="toolbar"', headingStart);
      const headingEnd = formStart > headingStart ? formStart : toolbarStart > headingStart ? toolbarStart : renderer.length;
      assert.equal((renderer.slice(headingStart, headingEnd).match(/class="help"/g) || []).length, 1, `${name} keeps one page subtitle`);
      if (hasPreview) assert.match(renderer, /previewLink\(\)/, `${name} keeps its Preview Website action`);
    }
    for (const label of ['Edit Homepage', 'Navigation Menu', 'Section Content', 'About Our School', 'Change Photos', 'Facilities', 'Academic Programs', 'Why Choose ENPEE', 'Activities', 'Sports Academy', 'Events', 'Gallery', 'Announcements / Marquee', 'Testimonials', 'Leadership', 'Parents’ Corner', 'Technology Partners', 'Infrastructure Providers', 'Admission Enquiries', 'Contact Details', 'Preview Website']) {
      assert.ok(navigation.includes(label), `admin navigation includes ${label}`);
    }
    const websitePage = await request('/');
    assert.equal(websitePage.response.status, 200);
    assert.match(websitePage.data, /id="notice-marquee"/, 'the public page includes the marquee below the header');
    assert.match(websitePage.data, /@keyframes notice-scroll/, 'the marquee has a CSS scrolling animation');
    assert.match(websitePage.data, /id="content-detail"/, 'CMS detail routes have a public detail view');
    assert.match(websitePage.data, /id="events-section"/, 'the public page has a CMS-driven events section');
    assert.match(websitePage.data, /id="leadership-section"/, 'the public page has a CMS-driven leadership section');
    assert.match(websitePage.data, /id="youtube-gallery"/, 'the public homepage includes the CMS video gallery');
    assert.match(websitePage.data, /id="parents-enquiry-form"/, 'the public page includes the parent enquiry form');
    assert.match(websitePage.data, /id="school-mascot"/, 'the public page includes the interactive school companion');
    assert.match(websitePage.data, /nav-dropdown-toggle/, 'the public page includes accessible dropdown navigation');
    const welcomeMascot = await request('/assets/enpee-mascot-welcome.webp');
    assert.equal(welcomeMascot.response.status, 200);
    assert.match(welcomeMascot.response.headers.get('content-type'), /image\/webp/);
    const mascotAnimation = await request('/assets/enpee-mascot-animation.json');
    assert.equal(mascotAnimation.response.status, 200);
    assert.equal(mascotAnimation.data.assets[0].p, 'enpee-mascot-welcome.webp');
    const lottiePlayer = await request('/assets/lottie.min.js');
    assert.equal(lottiePlayer.response.status, 200);
    assert.match(lottiePlayer.response.headers.get('content-type'), /javascript/);
    const initialPublicContent = await request('/api/public/content');
    assert.equal(initialPublicContent.data.documents.sections.navContact, 'Contact Us');
    assert.equal(initialPublicContent.data.documents.sections.parentEnquiryHeading, 'Send a parent enquiry');
    const initialNavigation = initialPublicContent.data.documents.navigation.items;
    assert.ok(initialNavigation.some((item) => item.id === 'about-us' && !item.parentId));
    assert.deepEqual(initialNavigation.filter((item) => item.parentId === 'about-us').map((item) => item.label), [
      'About the School', 'Promoters', 'Management', 'Advisory Board', 'CBSE Mandatory Disclosure'
    ]);
    assert.ok(initialNavigation.some((item) => item.label === 'Admissions Enquiry' && item.prominent));
    assert.deepEqual(
      initialPublicContent.data.collections.youtubeVideos.map((item) => item.videoId).sort(),
      ['51JIyUQ92BM', '7oKB8BsWht4', 'jK2BNKqiNeU'].sort(),
      'the three verified school videos are seeded for the public gallery'
    );
    for (const [route, title] of [
      ['/about', 'About ENPEE International School'], ['/promoters', 'Promoters'],
      ['/management', 'Management'], ['/chateau-francais', 'Château Français'],
      ['/way-we-work', 'The Way We Work'], ['/programs-offered', 'Programs Offered'],
      ['/what-makes-us-different', 'What Makes Us Different'], ['/contact-us', 'Contact Us']
    ]) {
      const page = await request(route);
      assert.equal(page.response.status, 200, `${route} is published`);
      assert.match(page.data, new RegExp(`<title>${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| ENPEE International School<\\/title>`));
      assert.match(page.data, /classList\.add\('cms-route-loading'\)/, `${route} waits for its CMS page content`);
    }
    for (const [route, destination] of [
      ['/index.php', '/'], ['/about.php', '/about'], ['/promoters.php', '/promoters'],
      ['/management.php', '/management'], ['/advisory-board.php', '/management#advisory-board'],
      ['/chateau-francais.php', '/chateau-francais'], ['/way-we-work.php', '/way-we-work'],
      ['/programs-offered.php', '/programs-offered'], ['/what-makes-different.php', '/what-makes-us-different'],
      ['/contact.php', '/contact-us']
    ]) {
      const alias = await fetch(`${origin}${route}`, { redirect: 'manual' });
      assert.equal(alias.status, 301, `${route} redirects to the existing public route`);
      assert.equal(alias.headers.get('location'), destination, `${route} preserves its canonical destination`);
    }
    const disclosureAlias = await fetch(`${origin}/cbse-mandatory-disclosure.php`, { redirect: 'manual' });
    assert.equal(disclosureAlias.status, 301);
    assert.equal(disclosureAlias.headers.get('location'), 'https://www.enpeekkl.com/cbse-mandatory-disclosure.php');
    const sitemap = await request('/sitemap.xml');
    for (const route of ['/about', '/promoters', '/management', '/chateau-francais', '/way-we-work', '/programs-offered', '/what-makes-us-different', '/contact-us']) {
      assert.ok(sitemap.data.includes(`${origin}${route}`), `sitemap includes ${route}`);
    }
    const privateResult = await request('/api/admin/dashboard');
    assert.equal(privateResult.response.status, 401);
    const emptyLogin = await request('/api/auth/login', { method: 'POST' });
    assert.equal(emptyLogin.response.status, 401);
    const emptyReset = await request('/api/auth/reset', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(emptyReset.response.status, 400);

    const login = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword })
    });
    assert.equal(login.response.status, 200);
    let cookie = login.response.headers.get('set-cookie').split(';')[0];
    let csrf = login.data.csrfToken;
    const headers = () => ({ cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });
    const sectionDocument = await request('/api/admin/documents/sections', { headers: { cookie } });
    assert.equal(sectionDocument.response.status, 200);
    assert.ok(sectionDocument.data.galleryFilters.includes('All photos'));
    const updatedSections = {
      ...sectionDocument.data,
      campusHeading: 'A CMS-updated campus heading',
      officeHoursLabel: 'Visiting times',
      footerPromotersLinkText: 'School Promoters',
      languageOptions: ['Tamil', 'French'],
      gradeOptions: ['Pre-KG', 'Class I']
    };
    delete updatedSections.updatedAt;
    const saveSections = await request('/api/admin/documents/sections', {
      method: 'PUT', headers: headers(), body: JSON.stringify(updatedSections)
    });
    assert.equal(saveSections.response.status, 200);
    assert.deepEqual(saveSections.data.gradeOptions, ['Pre-KG', 'Class I']);
    assert.equal(saveSections.data.officeHoursLabel, 'Visiting times');
    assert.equal(saveSections.data.footerPromotersLinkText, 'School Promoters');
    const navigationDocument = await request('/api/admin/documents/navigation', { headers: { cookie } });
    assert.equal(navigationDocument.response.status, 200);
    const updatedNavigation = JSON.parse(JSON.stringify(navigationDocument.data));
    delete updatedNavigation.updatedAt;
    updatedNavigation.items.find((item) => item.id === 'contact-us').label = 'Contact the School';
    updatedNavigation.items.find((item) => item.id === 'contact-us').displayOrder = 45;
    updatedNavigation.items.push({
      id: 'hidden-menu-item', label: 'Hidden menu item', href: '/about', parentId: 'about-us',
      displayOrder: 60, visible: false, prominent: false, newTab: false
    });
    const saveNavigation = await request('/api/admin/documents/navigation', {
      method: 'PUT', headers: headers(), body: JSON.stringify(updatedNavigation)
    });
    assert.equal(saveNavigation.response.status, 200);
    assert.equal(saveNavigation.data.items.find((item) => item.id === 'contact-us').label, 'Contact the School');
    const unsafeNavigation = JSON.parse(JSON.stringify(saveNavigation.data));
    delete unsafeNavigation.updatedAt;
    unsafeNavigation.items.find((item) => item.id === 'contact-us').href = 'javascript:alert(1)';
    const rejectedNavigation = await request('/api/admin/documents/navigation', {
      method: 'PUT', headers: headers(), body: JSON.stringify(unsafeNavigation)
    });
    assert.equal(rejectedNavigation.response.status, 400, 'unsafe navigation URLs are rejected');

    const pagesDocument = await request('/api/admin/documents/pages', { headers: { cookie } });
    assert.equal(pagesDocument.response.status, 200);
    const updatedPages = JSON.parse(JSON.stringify(pagesDocument.data));
    delete updatedPages.updatedAt;
    updatedPages.about.sections.push({
      heading: 'CMS editable section', body: 'Saved from the integration test.',
      image: '', bullets: [], published: true
    });
    const savedPages = await request('/api/admin/documents/pages', {
      method: 'PUT', headers: headers(), body: JSON.stringify(updatedPages)
    });
    assert.equal(savedPages.response.status, 200);
    assert.equal(savedPages.data.about.sections.at(-1).heading, 'CMS editable section');
    const invalidPages = JSON.parse(JSON.stringify(savedPages.data));
    delete invalidPages.updatedAt;
    invalidPages.about.sections[0].published = 'yes';
    const rejectedPages = await request('/api/admin/documents/pages', {
      method: 'PUT', headers: headers(), body: JSON.stringify(invalidPages)
    });
    assert.equal(rejectedPages.response.status, 400, 'invalid page visibility is rejected');

    const createdVideo = await request('/api/admin/collections/youtubeVideos', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ title: 'CMS Test School Video', videoUrl: 'https://youtu.be/51JIyUQ92BM', published: true, displayOrder: 20 })
    });
    assert.equal(createdVideo.response.status, 201);
    assert.equal(createdVideo.data.videoId, '51JIyUQ92BM');
    const invalidVideo = await request('/api/admin/collections/youtubeVideos', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ title: 'Invalid CMS Video', videoUrl: 'https://example.test/video', published: true })
    });
    assert.equal(invalidVideo.response.status, 400, 'non-YouTube video URLs are rejected');
    const publicVideos = await request('/api/public/content');
    assert.ok(publicVideos.data.collections.youtubeVideos.some((item) => item.title === 'CMS Test School Video'));

    const forbidden = await request('/api/admin/collections/facilities', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No CSRF' })
    });
    assert.equal(forbidden.response.status, 403);

    const created = await request('/api/admin/collections/facilities', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ title: 'CMS Test Facility', description: 'Created by integration test', published: true, displayOrder: 1 })
    });
    assert.equal(created.response.status, 201);
    const itemId = created.data.id;
    const edited = await request(`/api/admin/collections/facilities/${itemId}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ title: 'Updated Test Facility', description: 'Persisted edit', published: true, displayOrder: 2 })
    });
    assert.equal(edited.response.status, 200);
    const pendingTestimonial = await request('/api/admin/collections/testimonials', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ title: 'Pending testimonial', description: 'Awaiting review', parentName: 'Test Parent', published: true, approved: false, displayOrder: 1 })
    });
    assert.equal(pendingTestimonial.response.status, 201);
    const pendingPublicContent = await request('/api/public/content');
    assert.ok(!pendingPublicContent.data.collections.testimonials.some((item) => item.title === 'Pending testimonial'), 'unapproved testimonials are not public');
    const approvedTestimonial = await request(`/api/admin/collections/testimonials/${pendingTestimonial.data.id}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ title: 'Approved testimonial', description: 'Approved for publication', parentName: 'Test Parent', published: true, approved: true, displayOrder: 1 })
    });
    assert.equal(approvedTestimonial.response.status, 200);
    const publicContent = await request('/api/public/content');
    assert.equal(publicContent.data.documents.sections.campusHeading, 'A CMS-updated campus heading');
    assert.equal(publicContent.data.documents.sections.officeHoursLabel, 'Visiting times');
    assert.ok(publicContent.data.collections.facilities.some((item) => item.title === 'Updated Test Facility'));
    assert.ok(publicContent.data.collections.testimonials.some((item) => item.title === 'Approved testimonial'), 'approved testimonials are published');
    assert.equal(publicContent.data.documents.home.heroImage, 'https://www.enpeekkl.com/images/banner/home-banner-01.jpg');
    assert.equal(publicContent.data.documents.home.logoImage, '/uploads/previously-uploaded-logo.webp');
    assert.equal(publicContent.data.documents.home.marqueeEnabled, true);
    assert.equal(publicContent.response.headers.get('cache-control'), 'no-store');
    const recoveredLogo = await request(publicContent.data.documents.home.logoImage);
    assert.equal(recoveredLogo.response.status, 200);
    assert.match(recoveredLogo.response.headers.get('content-type'), /image\/webp/);
    assert.deepEqual(publicContent.data.documents.home.statistics, expectedStatistics);
    assert.equal(publicContent.data.collections.programs.find((item) => item.title === 'Pre-KG').image, 'https://www.enpeekkl.com/images/pic-pre-kg.jpg');
    const galleryImages = publicContent.data.collections.gallery.map((item) => item.image);
    assert.equal(new Set(galleryImages).size, galleryImages.length, 'school gallery uses distinct school photos');
    assert.ok(!publicContent.data.collections.gallery.some((item) => item.title === 'Library'), 'gallery does not claim an unverified library photo');
    assert.equal(publicContent.data.collections.leadership.length, 7, 'verified leadership records are made available to the website');
    assert.equal(publicContent.data.documents.about.chateauPublished, true);
    assert.ok(publicContent.data.documents.about.wayWeWork);
    const seededProgram = publicContent.data.collections.programs.find((item) => item.title === 'Pre-KG');
    const programSlug = `${seededProgram.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${seededProgram.id.slice(0, 8)}`;
    const programRoute = await request(`/programs/${programSlug}`);
    assert.equal(programRoute.response.status, 200);
    assert.match(programRoute.data, /<title>Pre-KG \| ENPEE International School<\/title>/, 'program routes include server-rendered page titles');
    assert.match(programRoute.data, /<meta name="description" content="Early childhood development and experiential learning\.">/);
    const initialSitemap = await request('/sitemap.xml');
    assert.match(initialSitemap.data, new RegExp(`/programs/${programSlug}`));

    const document = await request('/api/admin/documents/home', { headers: { cookie } });
    assert.equal(document.response.status, 200);
    const updatedHome = { ...document.data, heroHeading: 'CMS content is live', heroImage: 'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?auto=format&fit=crop&w=1200&q=80', logoImage: 'https://www.enpeekkl.com/images/banner/home-banner-01.jpg', marqueeEnabled: false };
    delete updatedHome.updatedAt;
    const saveHome = await request('/api/admin/documents/home', {
      method: 'PUT', headers: headers(), body: JSON.stringify(updatedHome)
    });
    assert.equal(saveHome.response.status, 200);
    const liveHome = await request('/api/public/content');
    assert.equal(liveHome.data.documents.home.heroHeading, 'CMS content is live');
    assert.equal(liveHome.data.documents.home.logoImage, 'https://www.enpeekkl.com/images/banner/home-banner-01.jpg');
    assert.equal(liveHome.data.documents.home.marqueeEnabled, false);
    const invalidMarqueeToggle = await request('/api/admin/documents/home', {
      method: 'PUT', headers: headers(), body: JSON.stringify({ ...updatedHome, marqueeEnabled: 'false' })
    });
    assert.equal(invalidMarqueeToggle.response.status, 400, 'the marquee toggle accepts only a boolean');
    const about = await request('/api/admin/documents/about', { headers: { cookie } });
    const editedAbout = {
      ...about.data,
      introduction: 'Updated school introduction',
      chateauDescription: 'CMS-managed Château Français details.',
      chateauPublished: true,
      wayWeWork: 'CMS-managed learning approach.',
      wayWeWorkPublished: true,
      parentsCornerMessage: 'Families can find school updates here.',
      parentsCornerPublished: true
    };
    delete editedAbout.updatedAt;
    const saveAbout = await request('/api/admin/documents/about', {
      method: 'PUT', headers: headers(), body: JSON.stringify(editedAbout)
    });
    assert.equal(saveAbout.response.status, 200);
    const syncedPublic = await request('/api/public/content');
    assert.equal(syncedPublic.data.documents.home.welcomeText, 'Updated school introduction');
    assert.equal(syncedPublic.data.documents.about.chateauDescription, 'CMS-managed Château Français details.');
    assert.equal(syncedPublic.data.documents.about.parentsCornerPublished, true);

    const draftAnnouncement = await request('/api/admin/collections/announcements', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ title: 'CMS Test Announcement', description: 'Draft announcement', published: false, important: true })
    });
    assert.equal(draftAnnouncement.response.status, 201);
    assert.ok(!syncedPublic.data.collections.announcements.some((item) => item.title === 'CMS Test Announcement'));
    const publishAnnouncement = await request(`/api/admin/collections/announcements/${draftAnnouncement.data.id}`, {
      method: 'PUT', headers: headers(),
      body: JSON.stringify({ title: 'CMS Test Announcement', description: 'Now published', published: true, important: true })
    });
    assert.equal(publishAnnouncement.response.status, 200);
    const publicAnnouncement = await request('/api/public/content');
    assert.ok(publicAnnouncement.data.collections.announcements.some((item) => item.title === 'CMS Test Announcement'));

    const invalidEvent = await request('/api/admin/collections/events', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ title: 'Undated event', description: 'This event must have a date.', published: true })
    });
    assert.equal(invalidEvent.response.status, 400, 'events require a valid calendar date');
    const draftEvent = await request('/api/admin/collections/events', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ title: 'CMS Open Day', description: 'Draft event details', eventDate: '2026-10-12', published: false, displayOrder: 1 })
    });
    assert.equal(draftEvent.response.status, 201);
    const draftPublic = await request('/api/public/content');
    assert.ok(!draftPublic.data.collections.events.some((item) => item.title === 'CMS Open Day'), 'draft events remain private');
    const hiddenEventRoute = await request(`/events/cms-open-day-${draftEvent.data.id.slice(0, 8)}`);
    assert.equal(hiddenEventRoute.response.status, 404, 'draft events do not have a public detail page');
    const publishedEvent = await request(`/api/admin/collections/events/${draftEvent.data.id}`, {
      method: 'PUT', headers: headers(),
      body: JSON.stringify({ title: 'CMS Open Day', description: 'Published event details', eventDate: '2026-10-12', published: true, displayOrder: 1 })
    });
    assert.equal(publishedEvent.response.status, 200);
    const publicEvent = await request('/api/public/content');
    assert.ok(publicEvent.data.collections.events.some((item) => item.title === 'CMS Open Day'));
    const eventRoute = await request(`/events/cms-open-day-${draftEvent.data.id.slice(0, 8)}`);
    assert.equal(eventRoute.response.status, 200);
    assert.match(eventRoute.data, /<title>CMS Open Day \| ENPEE International School<\/title>/, 'event routes include server-rendered page titles');
    const updatedSitemap = await request('/sitemap.xml');
    assert.match(updatedSitemap.data, new RegExp(`/events/cms-open-day-${draftEvent.data.id.slice(0, 8)}`));

    const enquiry = await request('/api/public/enquiries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parentName: 'Test Parent', studentName: 'Test Student', mobile: '+91 9876543210',
        email: 'parent@example.test', applyingClass: 'Class VI', academicYear: '2026–27',
        previousSchool: 'St. Mary’s Matriculation School', message: 'Please call after 3 PM.'
      })
    });
    assert.equal(enquiry.response.status, 201);
    const enquiryList = await request('/api/admin/enquiries?q=parent%40example.test', { headers: { cookie } });
    assert.equal(enquiryList.data.total, 1);
    const enquiryId = enquiryList.data.items[0].id;
    const statusUpdate = await request(`/api/admin/enquiries/${enquiryId}`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ status: 'Contacted', internalNotes: 'Called the family.' })
    });
    assert.equal(statusUpdate.response.status, 200);
    const detail = await request(`/api/admin/enquiries/${enquiryId}`, { headers: { cookie } });
    assert.equal(detail.data.status, 'Contacted');
    assert.equal(detail.data.previous_school, 'St. Mary’s Matriculation School');
    assert.equal(detail.data.internal_notes, 'Called the family.');
    const contactMessage = await request('/api/public/enquiries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'contact', parentName: 'Contact Sender', email: 'contact@example.test', message: 'A contact-form message.' })
    });
    assert.equal(contactMessage.response.status, 201);
    const contacts = await request('/api/admin/enquiries?class=General%20Contact', { headers: { cookie } });
    assert.equal(contacts.data.total, 1);
    assert.equal(contacts.data.items[0].type, 'Contact');
    const parentEnquiry = await request('/api/public/enquiries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'parent', parentName: 'Parent Visitor', email: 'visitor@example.test', message: 'Please arrange a campus visit.' })
    });
    assert.equal(parentEnquiry.response.status, 201);
    assert.match(parentEnquiry.data.message, /parent enquiry/i);
    const parentEnquiries = await request('/api/admin/enquiries?class=Parent%20Enquiry', { headers: { cookie } });
    assert.equal(parentEnquiries.data.total, 1);
    assert.equal(parentEnquiries.data.items[0].type, 'Parent');

    const imageBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#183653' } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([imageBytes], { type: 'image/png' }), 'campus.png');
    form.append('category', 'Testing');
    const uploadResult = await request('/api/admin/media', {
      method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: form
    });
    assert.equal(uploadResult.response.status, 201);
    assert.equal(uploadResult.data.mime_type, 'image/webp');
    assert.ok(uploadResult.data.filename.endsWith('.webp'));
    const uploaded = await request(uploadResult.data.url);
    assert.equal(uploaded.response.status, 200);
    assert.match(uploaded.response.headers.get('content-type'), /image\/webp/);
    const mediaReference = await request(`/api/admin/collections/facilities/${itemId}`, {
      method: 'PUT', headers: headers(),
      body: JSON.stringify({ title: 'Updated Test Facility', description: 'Persisted edit', image: uploadResult.data.url, published: true, displayOrder: 2 })
    });
    assert.equal(mediaReference.response.status, 200);
    const replacementForm = new FormData();
    replacementForm.append('file', new Blob([imageBytes], { type: 'image/png' }), 'replacement.png');
    const replacement = await request(`/api/admin/media/${uploadResult.data.id}/replace`, {
      method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: replacementForm
    });
    assert.equal(replacement.response.status, 200);
    const protectedDelete = await request(`/api/admin/media/${uploadResult.data.id}`, {
      method: 'DELETE', headers: headers()
    });
    assert.equal(protectedDelete.response.status, 409);
    const deleteReference = await request(`/api/admin/collections/facilities/${itemId}`, {
      method: 'DELETE', headers: headers()
    });
    assert.equal(deleteReference.response.status, 200);
    const deleteMedia = await request(`/api/admin/media/${uploadResult.data.id}`, {
      method: 'DELETE', headers: headers()
    });
    assert.equal(deleteMedia.response.status, 200);

    const csv = await request('/api/admin/enquiries.csv', { headers: { cookie } });
    assert.equal(csv.response.status, 200);
    assert.match(csv.response.headers.get('content-type'), /text\/csv/);
    assert.match(csv.data, /Previous school/);

    const homeBeforeMigration = await request('/api/admin/documents/home', { headers: { cookie } });
    const legacyStatistics = [
      { title: 'CBSE Curriculum', detail: 'NCERT-based learning' },
      { title: 'Digitized Classrooms', detail: 'Interactive learning' },
      { title: '5-Acre Campus', detail: 'Green and secure' },
      { title: 'Sports Academy', detail: 'Advanced sports assessment' }
    ];
    legacyStatistics[0] = { title: 'Office-edited Curriculum', detail: 'Staff-written details' };
    const homeWithLegacyStatistics = { ...homeBeforeMigration.data, statistics: legacyStatistics };
    delete homeWithLegacyStatistics.updatedAt;
    const saveLegacyStatistics = await request('/api/admin/documents/home', {
      method: 'PUT', headers: headers(), body: JSON.stringify(homeWithLegacyStatistics)
    });
    assert.equal(saveLegacyStatistics.response.status, 200);

    const passwordUpdate = await request('/api/auth/password', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ currentPassword: adminPassword, newPassword: updatedPassword })
    });
    assert.equal(passwordUpdate.response.status, 200);
    const logout = await request('/api/auth/logout', { method: 'POST', headers: headers() });
    assert.equal(logout.response.status, 200);
    const loggedOut = await request('/api/admin/dashboard', { headers: { cookie } });
    assert.equal(loggedOut.response.status, 401);

    await stopServer();
    await startServer();
    const persisted = await request('/api/public/content');
    assert.equal(persisted.data.documents.home.heroHeading, 'CMS content is live');
    assert.equal(persisted.data.documents.home.heroImage, 'https://www.enpeekkl.com/images/banner/home-banner-01.jpg');
    assert.equal(persisted.data.documents.home.logoImage, 'https://www.enpeekkl.com/images/banner/home-banner-01.jpg');
    assert.equal(persisted.data.documents.home.marqueeEnabled, false, 'the marquee preference remains saved across restarts');
    assert.deepEqual(persisted.data.documents.home.statistics, [
      { title: 'Office-edited Curriculum', detail: 'Staff-written details' },
      ...expectedStatistics.slice(1)
    ]);
    assert.ok(persisted.data.collections.announcements.some((item) => item.title === 'CMS Test Announcement'));
    const persistedDashboard = await request('/api/admin/dashboard', { headers: { cookie } });
    assert.equal(persistedDashboard.response.status, 401);
    const newLogin = await request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: updatedPassword })
    });
    assert.equal(newLogin.response.status, 200);
  } finally {
    await stopServer();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
