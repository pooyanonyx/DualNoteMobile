# DualNote Mobile

PDF annotator and notebook side by side. Installable web app (PWA) that works offline.

Live: https://pooyanonyx.github.io/DualNoteMobile/

## Folder layout
- `index.html`, `manifest.webmanifest`, `sw.js`, `precache.json` - app entry (must stay in the root)
- `css/` - styles
- `js/` - app code
- `icons/` - app icons
- `lib/` - third-party libraries (jszip, pdf-lib, pdf.js, fonts, cmaps)

## Deploy
Upload everything in this folder to the root of the repo (or any web server folder).
GitHub Pages: Settings -> Pages -> Deploy from a branch -> `main` / `(root)`.

## Notes
After changing any file, bump `CACHE` in `sw.js` (e.g. `dualnote-v3`) so devices pick up the update.
If you add or remove files, update `precache.json`.
