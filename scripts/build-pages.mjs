import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, 'dist');
const sourceHtml = path.join(root, 'ENPEE International School, Karaikal – CBSE School.html');
const basePath = (process.env.PAGES_BASE_PATH || '/ENPEE/').replace(/\/?$/, '/');
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

let html = fs.readFileSync(sourceHtml, 'utf8');

// Inject GitHub Pages base path and optional external API URL
html = html.replace(
  '<meta name="enpee-base-path" content="">',
  `<meta name="enpee-base-path" content="${basePath}">`
);
html = html.replace(
  '<meta name="enpee-api-base" content="">',
  `<meta name="enpee-api-base" content="${apiBase.replace(/"/g, '&quot;')}">`
);

// Rewrite root-relative /assets/ references to include the GitHub Pages base path
html = html.replace(/(["'(])\/assets\//g, `$1${basePath}assets/`);

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
