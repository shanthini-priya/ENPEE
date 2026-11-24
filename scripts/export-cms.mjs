import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

export async function getCmsContent() {
  const dbFile = path.join(root, 'data', 'enpee.sqlite');
  const cmsJsonFile = path.join(root, 'data', 'cms-content.json');

  if (fs.existsSync(dbFile)) {
    try {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(dbFile, { readonly: true });

      const allowedCollections = [
        'facilities', 'programs', 'gallery', 'features', 'activities', 'announcements', 'testimonials',
        'events', 'sports', 'technologyPartners', 'infrastructureProviders', 'leadership', 'parentResources', 'youtubeVideos'
      ];

      const documents = Object.fromEntries(
        db.prepare('SELECT key, payload FROM site_documents').all().map(({ key, payload }) => {
          try { return [key, JSON.parse(payload)]; } catch { return [key, {}]; }
        })
      );

      const collections = {};
      for (const collection of allowedCollections) {
        collections[collection] = db.prepare(
          "SELECT id, payload, created_at, updated_at FROM content_items WHERE collection=? ORDER BY json_extract(payload, '$.displayOrder'), created_at"
        )
          .all(collection)
          .map((item) => {
            try {
              return { id: item.id, ...JSON.parse(item.payload), createdAt: item.created_at, updatedAt: item.updated_at };
            } catch {
              return { id: item.id, createdAt: item.created_at, updatedAt: item.updated_at };
            }
          })
          .filter((item) => item.published && (collection !== 'testimonials' || item.approved));
      }

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
        sections: cmsSections.map((sec) => ({
          ...sec,
          blocks: Object.fromEntries(cmsBlocks.filter((b) => b.section_id === sec.id).map((b) => [b.block_key, b.published_value])),
          images: cmsImages.filter((img) => img.section_id === sec.id),
          marquees: cmsMarquees.filter((m) => m.section_id === sec.id)
        })),
        activeMarquees: cmsMarquees
      };

      db.close();
      const payload = { documents, collections, dynamicCms };

      // Ensure data/ directory exists and write JSON
      fs.mkdirSync(path.dirname(cmsJsonFile), { recursive: true });
      fs.writeFileSync(cmsJsonFile, JSON.stringify(payload, null, 2), 'utf8');
      return payload;
    } catch (err) {
      console.warn('⚠️ Could not query SQLite directly:', err.message);
    }
  }

  if (fs.existsSync(cmsJsonFile)) {
    try {
      return JSON.parse(fs.readFileSync(cmsJsonFile, 'utf8'));
    } catch (err) {
      console.warn('⚠️ Could not read fallback cms-content.json:', err.message);
    }
  }

  return null;
}

if (process.argv[1] === __filename) {
  const content = await getCmsContent();
  if (content) {
    console.log('✅ Successfully exported CMS content to data/cms-content.json');
    console.log('Documents:', Object.keys(content.documents || {}).length);
    console.log('Collections:', Object.keys(content.collections || {}).length);
    console.log('Dynamic Sections:', content.dynamicCms?.sections?.length || 0);
  } else {
    console.error('❌ Failed to export CMS content.');
    process.exit(1);
  }
}
