# DualNote Mobile

PDF annotator and notebook side by side. Installable web app (PWA) that works offline.

Live: https://pooyanonyx.github.io/DualNoteMobile/

## Folder layout
- `index.html`, `manifest.webmanifest`, `sw.js`, `precache.json` - app entry (must stay in the root)
- `css/` - styles
- `js/` - app code
- `icons/` - app icons
- `lib/` - third-party libraries (jszip, pdf-lib, pdf.js, pdf fonts, cmaps) and `lib/fonts/` (Vazirmatn, Persian font, SIL OFL)

## Deploy
Upload everything in this folder to the root of the repo (or any web server folder).
GitHub Pages: Settings -> Pages -> Deploy from a branch -> `main` / `(root)`.

## Notes
After changing any file, bump `CACHE` in `sw.js` (e.g. `dualnote-v5`) so devices pick up the update.
If you add or remove files, update `precache.json`.

## Text direction and alignment
Text and note items can carry `dir` (`ltr`/`rtl`) and `align` (`left`/`center`/`right`) - two separate properties - and text boxes a
fixed width `w`. Items without them (older files) keep the old behaviour. PDF and notebook pages share the same continuous
page column (`js/panel.js`).
