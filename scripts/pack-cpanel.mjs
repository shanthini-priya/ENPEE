import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distZip = path.join(rootDir, 'enpee-cpanel.zip');
const stagingDir = path.join(rootDir, 'cpanel-staging');

console.log('📦 Starting comprehensive cPanel package build...');

// 1. Checkpoint SQLite database so all changes in WAL are committed into enpee.sqlite
const dbPath = path.join(rootDir, 'data', 'enpee.sqlite');
if (fs.existsSync(dbPath)) {
  try {
    const db = new Database(dbPath);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('💾 Checkpointed SQLite database.');
  } catch (err) {
    console.warn('⚠️ Warning checkpointing database:', err.message);
  }
}

// 2. Clean temporary SQLite files in data/
const shmPath = path.join(rootDir, 'data', 'enpee.sqlite-shm');
const walPath = path.join(rootDir, 'data', 'enpee.sqlite-wal');
if (fs.existsSync(shmPath)) try { fs.unlinkSync(shmPath); } catch (e) {}
if (fs.existsSync(walPath)) try { fs.unlinkSync(walPath); } catch (e) {}
const cmsDb = path.join(rootDir, 'data', 'cms.db');
const siteDb = path.join(rootDir, 'data', 'site.db');
if (fs.existsSync(cmsDb)) try { fs.unlinkSync(cmsDb); } catch (e) {}
if (fs.existsSync(siteDb)) try { fs.unlinkSync(siteDb); } catch (e) {}

// 3. Build production static routes with root domain base path (PAGES_BASE_PATH="")
console.log('🔨 Generating clean pre-rendered subpage routes with root base path...');
const buildProc = spawnSync('node', [path.join(rootDir, 'scripts', 'build-pages.mjs')], {
  cwd: rootDir,
  env: { ...process.env, PAGES_BASE_PATH: '' },
  stdio: 'inherit'
});
if (buildProc.status !== 0) {
  console.error('❌ Failed to pre-render static pages.');
  process.exit(1);
}

// 4. Prepare clean staging directory
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
fs.mkdirSync(stagingDir, { recursive: true });

// Copy individual files to staging
const rootFiles = [
  'server.mjs',
  'server.js',
  'app.js',
  'sections_data.mjs',
  'package.json',
  'package-lock.json',
  '.htaccess',
  '.env.example',
  'admin.html',
  'index.html'
];

if (fs.existsSync(path.join(rootDir, '.env'))) {
  rootFiles.push('.env');
}

for (const file of rootFiles) {
  const src = path.join(rootDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(stagingDir, file));
  } else {
    console.warn(`⚠️ Warning: missing file ${file}`);
  }
}

// Copy directories to staging
const dirs = ['assets', 'uploads', 'data'];
for (const dir of dirs) {
  const src = path.join(rootDir, dir);
  const dest = path.join(stagingDir, dir);
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true });
  }
}

// Copy all subpage route folders from dist/ into staging root
const distDir = path.join(rootDir, 'dist');
if (fs.existsSync(distDir)) {
  const distEntries = fs.readdirSync(distDir, { withFileTypes: true });
  for (const entry of distEntries) {
    if (entry.isDirectory() && entry.name !== 'assets' && entry.name !== 'uploads' && entry.name !== 'data') {
      const srcSub = path.join(distDir, entry.name);
      const destSub = path.join(stagingDir, entry.name);
      fs.cpSync(srcSub, destSub, { recursive: true });
    }
  }
  // Also include dist folder itself for optional reference
  fs.cpSync(distDir, path.join(stagingDir, 'dist'), { recursive: true });
}

// 5. Remove existing enpee-cpanel.zip
if (fs.existsSync(distZip)) {
  fs.unlinkSync(distZip);
  console.log('🗑️ Removed existing enpee-cpanel.zip');
}

// 6. Create zip archive from staging directory contents (Node.js PaaS Package)
console.log('⚡ Compressing all organized features and media into enpee-cpanel.zip...');
const stagingEntries = fs.readdirSync(stagingDir);

function createArchive(targetZip, sourceDir, entries) {
  if (fs.existsSync(targetZip)) {
    try { fs.unlinkSync(targetZip); } catch (e) {}
  }
  const tarRes = spawnSync('tar', ['-a', '-cf', targetZip, ...entries], {
    cwd: sourceDir,
    stdio: 'inherit'
  });
  if (tarRes.status === 0) return;

  const zipRes = spawnSync('zip', ['-r', targetZip, ...entries], {
    cwd: sourceDir,
    stdio: 'inherit'
  });
  if (zipRes.status === 0) return;

  if (process.platform === 'win32') {
    const paths = entries.map(item => `'${path.join(sourceDir, item).replace(/'/g, "''")}'`).join(', ');
    const psScript = `$ProgressPreference = 'SilentlyContinue'; Compress-Archive -Path ${paths} -DestinationPath '${targetZip.replace(/'/g, "''")}' -Force`;
    const psRes = spawnSync('powershell', ['-NoProfile', '-Command', psScript], {
      cwd: sourceDir,
      stdio: 'inherit'
    });
    if (psRes.status === 0) return;
  }
  console.error(`❌ Failed to create archive ${targetZip}`);
}

createArchive(distZip, stagingDir, stagingEntries);

// 6b. Also create static-only public_html package (for cPanel static hosting Solution One)
const staticZip = path.join(rootDir, 'enpee-static-public_html.zip');
console.log('⚡ Compressing clean static files into enpee-static-public_html.zip (for cPanel public_html)...');
if (fs.existsSync(distDir)) {
  const distStaticEntries = fs.readdirSync(distDir);
  createArchive(staticZip, distDir, distStaticEntries);
}

// 7. Cleanup staging directory
try {
  fs.rmSync(stagingDir, { recursive: true, force: true });
} catch (e) {}

// 8. Re-run standard GitHub Pages build for local git/dist sync
spawnSync('node', [path.join(rootDir, 'scripts', 'build-pages.mjs')], {
  cwd: rootDir,
  env: { ...process.env, PAGES_BASE_PATH: '/ENPEE/' },
  stdio: 'inherit'
});

// 9. Report
if (fs.existsSync(distZip)) {
  const stats = fs.statSync(distZip);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`\n🎉 Successfully generated Node.js PaaS cPanel package!`);
  console.log(`📁 File: ${distZip}`);
  console.log(`📊 Size: ${sizeMB} MB`);
}
if (fs.existsSync(staticZip)) {
  const stats = fs.statSync(staticZip);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`🎉 Successfully generated Static public_html package!`);
  console.log(`📁 File: ${staticZip}`);
  console.log(`📊 Size: ${sizeMB} MB`);
}
