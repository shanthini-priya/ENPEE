import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, 'dist');
const sourceHtml = path.join(root, 'index.html');
const rawBasePath = process.env.PAGES_BASE_PATH !== undefined ? process.env.PAGES_BASE_PATH : '/ENPEE/';
const basePath = rawBasePath ? rawBasePath.replace(/\/?$/, '/') : '';
const apiBase = (process.env.ENPEE_API_BASE || '').trim().replace(/\/+$/, '');

if (!fs.existsSync(sourceHtml)) {
  throw new Error(`Source HTML file not found: ${sourceHtml}`);
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

// Copy static assets directory
const assetsSrc = path.join(root, 'assets');
const assetsDest = path.join(distDir, 'assets');
if (fs.existsSync(assetsSrc)) {
  fs.cpSync(assetsSrc, assetsDest, { recursive: true });
}

// Copy static uploads directory
const uploadsSrc = path.join(root, 'uploads');
const uploadsDest = path.join(distDir, 'uploads');
if (fs.existsSync(uploadsSrc)) {
  fs.cpSync(uploadsSrc, uploadsDest, { recursive: true });
}

// Load CMS content and copy data directory
let cmsData = null;
const cmsJsonPath = path.join(root, 'data', 'cms-content.json');

try {
  const exportCmsPath = path.join(root, 'scripts', 'export-cms.mjs');
  if (fs.existsSync(exportCmsPath)) {
    const { getCmsContent } = await import('./export-cms.mjs');
    cmsData = await getCmsContent();
  }
} catch (e) {}

if (!cmsData && fs.existsSync(cmsJsonPath)) {
  try {
    cmsData = JSON.parse(fs.readFileSync(cmsJsonPath, 'utf8'));
  } catch (e) {}
}

const dataSrc = path.join(root, 'data');
const dataDest = path.join(distDir, 'data');
if (fs.existsSync(dataSrc)) {
  fs.cpSync(dataSrc, dataDest, {
    recursive: true,
    filter: (src) => !src.endsWith('.sqlite-shm') && !src.endsWith('.sqlite-wal')
  });
}

if (cmsData) {
  if (basePath) {
    const cb = basePath.replace(/\/+$/, '');
    const assetUploadPattern = new RegExp(`(["'\\(])(?:${cb})?\\/?(assets|uploads)\\/`, 'g');
    const jsonStr = JSON.stringify(cmsData).replace(assetUploadPattern, `$1${cb}/$2/`);
    cmsData = JSON.parse(jsonStr);
  }

  fs.mkdirSync(path.join(distDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'data', 'cms-content.json'), JSON.stringify(cmsData), 'utf8');

  fs.mkdirSync(path.join(distDir, 'api', 'public', 'content'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'api', 'public', 'content', 'index.html'), JSON.stringify(cmsData), 'utf8');
}

let html = fs.readFileSync(sourceHtml, 'utf8');

// Inject GitHub Pages base path and optional external API URL
html = html.replace(
  '<meta name="enpee-base-path" content="">',
  `<meta name="enpee-base-path" content="${basePath}">\n  <base href="${basePath}">`
);
html = html.replace(
  '<meta name="enpee-api-base" content="">',
  `<meta name="enpee-api-base" content="${apiBase.replace(/"/g, '&quot;')}">`
);

// Inject embedded initial CMS data bundle into HTML so it renders instantly with zero latency
if (cmsData) {
  const safeJson = JSON.stringify(cmsData).replace(/</g, '\\u003c');
  const initialDataScript = `<script id="enpee-initial-cms-data">window.__INITIAL_CMS_DATA__ = ${safeJson};</script>`;
  html = html.replace('</head>', `${initialDataScript}\n</head>`);
}

// Rewrite root-relative and relative assets/ and uploads/ references to include the GitHub Pages base path
if (basePath) {
  const cb = basePath.replace(/\/+$/, '');
  const assetUploadPattern = new RegExp(`(["'\\(])(?:${cb})?\\/?(assets|uploads)\\/`, 'g');
  html = html.replace(assetUploadPattern, `$1${cb}/$2/`);
}

// Remove references to optional mascot files if they are not present in assets/
const optionalAssetChecks = [
  {
    file: path.join(root, 'assets', 'mascot', 'enpee-buddy.css'),
    pattern: /<link\s+rel="stylesheet"\s+href="[^"]*enpee-buddy\.css"[^>]*>\s*/gi
  },
  {
    file: path.join(root, 'assets', 'mascot', 'enpee-buddy-sections.css'),
    pattern: /<link\s+rel="stylesheet"\s+href="[^"]*enpee-buddy-sections\.css"[^>]*>\s*/gi
  },
  {
    file: path.join(root, 'assets', 'mascot', 'enpee-buddy.js'),
    pattern: /<script\s+src="[^"]*enpee-buddy\.js"[^>]*><\/script>\s*/gi
  },
  {
    file: path.join(root, 'assets', 'mascot', 'enpee-buddy-sections.js'),
    pattern: /<script\s+src="[^"]*enpee-buddy-sections\.js"[^>]*><\/script>\s*/gi
  }
];

for (const check of optionalAssetChecks) {
  if (!fs.existsSync(check.file)) {
    html = html.replace(check.pattern, '');
  }
}

if (!fs.existsSync(path.join(root, 'assets', 'mascot', 'enpee-buddy.js'))) {
  html = html.replace(
    /<div\s+id="enpee-buddy-widget"[\s\S]*?<\/div>\s*(?=\s*<!-- Buddy Controller|<\/body>)/i,
    ''
  );
}

fs.writeFileSync(path.join(distDir, 'index.html'), html, 'utf8');

// Generate static pre-rendered routes for GitHub Pages direct URL access
const staticSubpages = [
  'about',
  'promoters',
  'management',
  'advisory-board',
  'cbse-mandatory-disclosure',
  'chateau-francais',
  'infrastructure',
  'digital-classrooms',
  'sports-academy',
  'student-activities',
  'way-we-work',
  'programs-offered',
  'what-makes-us-different',
  'photo-gallery',
  'gallery',
  'video-gallery',
  'videos',
  'events-celebrations',
  'events',
  'downloads',
  'contact-us'
];

for (const sub of staticSubpages) {
  const dir = path.join(distDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
}

// Build static admin UI for /ENPEE/admin and /ENPEE/admin.html
const sourceAdminHtml = path.join(root, 'admin.html');
if (fs.existsSync(sourceAdminHtml)) {
  let adminHtml = fs.readFileSync(sourceAdminHtml, 'utf8');
  adminHtml = adminHtml.replace(
    '<meta name="enpee-base-path" content="">',
    `<meta name="enpee-base-path" content="${basePath}">`
  );
  adminHtml = adminHtml.replace(
    '<meta name="enpee-api-base" content="">',
    `<meta name="enpee-api-base" content="${apiBase.replace(/"/g, '&quot;')}">`
  );
  fs.mkdirSync(path.join(distDir, 'admin'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'admin', 'index.html'), adminHtml, 'utf8');
  fs.writeFileSync(path.join(distDir, 'admin.html'), adminHtml, 'utf8');
}

// Create 404.html for GitHub Pages SPA direct-route & refresh support
const notFoundHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ENPEE International School, Karaikal</title>
  <script>
    (function () {
      var base = ${JSON.stringify(basePath.replace(/\/$/, ''))};
      var path = location.pathname;
      if (base && path.indexOf(base) === 0) {
        path = path.slice(base.length) || '/';
      }
      if (path === '/admin' || path.indexOf('/admin/') === 0 || path === '/admin.html') {
        location.replace(base + '/admin/' + location.search + location.hash);
        return;
      }
      var target = base + '/?route=' + encodeURIComponent(path + location.search) + location.hash;
      location.replace(target);
    })();
  </script>
</head>
<body></body>
</html>
`;

fs.writeFileSync(path.join(distDir, '404.html'), notFoundHtml, 'utf8');
fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf8');

console.log(`Built GitHub Pages output in ${distDir}`);
console.log(`Base path: ${basePath}`);
console.log(`API base: ${apiBase || '(static fallback mode — set ENPEE_API_BASE to connect external Express API)'}`);

