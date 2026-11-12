# ENPEE International School CMS

This keeps the existing single-file public website and serves it with a Node.js/Express backend. The CMS uses SQLite for durable content, administrator sessions, enquiries, and media metadata; uploaded media is stored on the server and optimized images are converted to WebP.

## Requirements

- Node.js 20 or newer
- npm

## First run

In PowerShell, from the project directory:

```powershell
Copy-Item .env.example .env
```

Edit `.env` before starting the server. Set a unique administrator email, a random password of at least 14 characters, and a random `SESSION_SECRET` of at least 32 characters. Do not commit `.env`.

```powershell
npm install
npm start
```

Open the public website at `http://localhost:3000/` and the protected admin portal at `http://localhost:3000/admin`. The first run creates the initial administrator from `ADMIN_EMAIL` and `ADMIN_PASSWORD`; subsequent restarts use the hashed account stored in SQLite. There are no default credentials.

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, and `PUBLIC_ORIGIN` to enable password reset links. Without SMTP, password reset requests return a generic response and do not send email; an administrator can still change their password while signed in.

## Content and operations

The public page reads editable home/about/contact documents and published content from `/api/public/content`. Its original markup remains as a graceful fallback if the server is unavailable. Open public pages refresh CMS content every minute; new visitors see the latest published content immediately. Admission and contact forms submit to the server and appear in **Admission Enquiries**. Content changes are persisted before they are returned to the admin.

SQLite is stored at `DB_PATH` (default `./data/enpee.sqlite`). Media is stored under `UPLOAD_DIR` (default `./uploads`). Back up both locations. Uploaded images and videos are limited to 40 MB each; images are validated, rotated, resized/oriented, and converted to WebP. Supported video formats are MP4 and WebM.

For production, serve the site over HTTPS, use a strong private `SESSION_SECRET`, set `NODE_ENV=production` and `PUBLIC_ORIGIN` to the canonical HTTPS origin, protect the server and its backups, and configure a trusted reverse proxy only if needed. The administrator cookie is HTTP-only, secure in production, and same-site strict; write APIs require the session CSRF token. Rate limits apply to login, reset, API, and public enquiry requests.

Run the integration tests with:

```powershell
npm test
```
