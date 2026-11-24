# ENPEE International School Section-Based CMS Architecture

## 1. Executive Summary & Architecture Overview
This plan transitions the existing ENPEE admin interface (`admin.html`) into a clean, modern **Section-Based Content Management System (CMS)** driven by the existing Node.js + SQLite backend (`server.mjs`) and frontend (`index.html`).

Existing core capabilities to preserve:
- SQLite persistence (`data/site.db` or `data/enpee.sqlite` via `better-sqlite3`).
- Authentication with CSRF protection, sessions, password reset, and secure file uploads via `multer` + `sharp`.
- Existing test suite (`node --test`).
- Zero changes to the visual chrome and layout of the public website (`index.html`).

---

## 2. Admin Modules Restructuring
The admin navigation will be replaced with the exact requested 5 core modules:
1. **Website Sections**:
   - Overview of all identified sections with visual status cards (blocks count, images count, marquee count, published status).
   - Clicking any section opens its dedicated Section Management Page.
2. **Admission Enquiries**:
   - Dedicated management page for student and parent enquiries.
   - Comprehensive CRUD operations, search, multi-filters (Date, Class, Status), sorting, status transition, view modal, and direct "Call Parent" tel links.
3. **Homepage Image Manager**:
   - Dedicated master manager auditing every image slot on the website.
   - Slot details: Section name, Slot key, Preview, Current dimensions, Required dimensions, Aspect ratio, Accepted formats, Image status.
   - Missing image detection: "IMAGE NOT UPLOADED" alert badge, red highlight, missing image counter, upload prompt.
4. **Media & PDF Manager**:
   - Dedicated digital asset manager for documents, PDFs (Brochures, Mandatory Disclosure, Circulars, Calendars), and site images.
   - Upload, preview, replace, copy URL, and delete.
5. **Admin Settings**:
   - Security credentials, password change, audit/activity logs, and database status.

---

## 3. Comprehensive Website Sections Identification
Mapped directly from `index.html`:
1. `top_header`: Top Utility Bar (Phone, Email, Virtual Tour, Social Links, Direct Contact Button).
2. `navigation_bar`: Main Navigation Bar (Brand Logo, Main Menus, Submenus, Enquire Button).
3. `notice_marquee`: Notice Marquee Ticker (Speed, Direction, Announcements list, Enable/Disable toggle).
4. `hero_section`: Panoramic Hero Section (Headings, Subheadings, Taglines, CTA buttons, Hero image slots).
5. `about_school`: About Our School (`#about` - History, Introduction, Accreditations, Pillars).
6. `campus_highlights`: Campus Highlights & Architecture (`#campus` - 5-Acre Eco-Campus, Features, Facility previews).
7. `academic_programmes`: Academic Programmes (`#academics` - Pre-KG, Primary, Middle School, Curriculum highlights).
8. `facilities`: Campus Facilities (`#features` & facilities - Smart Labs, Transport, Library, STEM).
9. `activities`: Student Activities (`#activities` - Performing Arts, Clubs, Field trips, Green Warriors).
10. `sports`: Sports Academy (`#sports` / disciplines - Skating Rink, Archery, Football, Athletics, Martial Arts).
11. `gallery`: Photo Moments Gallery (`#gallery` - Categories, Photos, Captions, Lightbox URLs).
12. `video_gallery`: Video Gallery (`#videos-section` - YouTube IDs, Thumbnails, Captions, Play overlays).
13. `school_philosophy`: School Philosophy (`.phil` - Knowledge | Innovation | Excellence, Core values).
14. `footer`: Footer Section (`footer` - Logo, Campus address, Affiliation info, Quick links, Partner logos).

---

## 4. Inside Each Section Management Page
Every section page features contextually relevant tabs:
- **Tab A: Content Management**: Text fields (headings, subheadings, paragraphs, button labels, button links, items list with add/edit/delete).
- **Tab B: Image Management**: Image slots with pre-configured dimension & aspect-ratio requirements, live preview, resolution validation, replace and delete.
- **Tab C: Marquee Management**: (Active on Marquee & Hero) announcements list, add/delete, speed control, enable/disable toggle.
- **Tab D: PDF Management**: (Active on About, Academics, Footer, Parents' Corner) upload PDF, title, description, download link, enable/disable.

---

## 5. Homepage Image Manager & Dimension Specifications
Predefined dimensions per section/slot based on frontend responsive rules:
- `Homepage Hero`: 1920 × 650 px (16:9 / 3.3:1)
- `Inner Page Banner`: 1920 × 450 px
- `Campus Images`: 1200 × 800 px (3:2)
- `Gallery Images`: 1200 × 800 px (3:2)
- `School Logo`: 500 × 500 px (1:1)
- `Profile / Chairman Images`: 600 × 600 px (1:1)
- `Section Images`: 1000 × 700 px
- `Video Thumbnails`: 1280 × 720 px (16:9)
- `Partner Logos`: 400 × 150 px

Validation rules:
- Supported formats: JPG, JPEG, PNG, WebP.
- Client-side & server-side image width and height verification via `Image()` and `sharp`.
- Rejection of low-resolution images with informative errors.
- Visual warning badges for empty image slots.

---

## 6. Admission Enquiries Management & Homepage Integration
- Form `#f` on `index.html` submits to `/api/public/enquiries`.
- Schema fields: `parentName`, `studentName`, `mobile`, `applyingClass`, `email`, `academicYear`, `status` (Pending, Contacted, Approved, Rejected), `created_at`.
- Admin table with real-time status change, modal detail view, inline phone action (`tel:...`), search, filters, pagination, and count badge.
