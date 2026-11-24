import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distZip = path.join(rootDir, 'enpee-cpanel.zip');

console.log('📦 Starting cPanel package build...');

// Files and folders required for production on cPanel:
const includeList = [
  'server.mjs',
  'app.js',
  'package.json',
  '.env.example',
  '.htaccess',
  'admin.html',
  'index.html',
  'assets',
  'data/.gitkeep',
  'uploads/.gitkeep'
];

// Verify all required items exist before bundling
for (const item of includeList) {
  const itemPath = path.join(rootDir, item);
  if (!fs.existsSync(itemPath)) {
    console.error(`❌ Required file/directory missing: ${item}`);
    process.exit(1);
  }
}

// Remove old zip if it exists
if (fs.existsSync(distZip)) {
  fs.unlinkSync(distZip);
  console.log('🗑️  Removed existing enpee-cpanel.zip');
}

function createArchive() {
  console.log('⚡ Archiving production files into enpee-cpanel.zip...');

  // Try tar first (available natively on modern Windows 10/11 and Linux)
  const tarRes = spawnSync('tar', ['-a', '-cf', 'enpee-cpanel.zip', ...includeList], {
    cwd: rootDir,
    stdio: 'inherit'
  });

  if (tarRes.status === 0) {
    return;
  }

  // Fallback to zip (standard on Linux/macOS)
  const zipRes = spawnSync('zip', ['-r', 'enpee-cpanel.zip', ...includeList], {
    cwd: rootDir,
    stdio: 'inherit'
  });

  if (zipRes.status === 0) {
    return;
  }

  // Fallback to PowerShell without progress bar on Windows
  if (process.platform === 'win32') {
    const paths = includeList.map(item => `'${path.join(rootDir, item).replace(/'/g, "''")}'`).join(', ');
    const psScript = `$ProgressPreference = 'SilentlyContinue'; Compress-Archive -Path ${paths} -DestinationPath '${distZip.replace(/'/g, "''")}' -Force`;
    const psRes = spawnSync('powershell', ['-NoProfile', '-Command', psScript], {
      cwd: rootDir,
      stdio: 'inherit'
    });
    if (psRes.status === 0) {
      return;
    }
  }

  console.error('❌ Failed to create zip archive with tar, zip, or powershell.');
  process.exit(1);
}

createArchive();

if (fs.existsSync(distZip)) {
  const stats = fs.statSync(distZip);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`\n✅ Successfully generated clean cPanel bundle!`);
  console.log(`📁 File: ${distZip}`);
  console.log(`📊 Size: ${sizeMB} MB`);
  console.log(`\nIncluded in bundle:`);
  includeList.forEach(item => console.log(`   + ${item}`));
  console.log(`\nExcluded from bundle:`);
  console.log(`   - node_modules/`);
  console.log(`   - data/ (SQLite database file)`);
  console.log(`   - uploads/ (User uploads)`);
  console.log(`   - .env (Sensitive credentials)`);
  console.log(`   - .git/ (Version control repository)`);
  console.log(`   - package-lock.json`);
} else {
  console.error('❌ Failed to find output zip.');
  process.exit(1);
}
