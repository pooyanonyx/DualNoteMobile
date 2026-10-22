# DualNote Mobile

PDF annotator and notebook side by side. Installable web app (PWA) that works offline.

Live: https://pooyanonyx.github.io/DualNoteMobile/

## Folder layout
- `index.html`, `manifest.webmanifest`, `sw.js`, `precache.json` - app entry (must stay in the root)
- `css/` - styles
- `js/` - app code
- `icons/` - app icons
- `lib/` - third-party libraries (jszip, pdf-lib, pdf.js, pdf fonts, cmaps) `lib/fonts/` (Vazirmatn, Persian font, SIL OFL) and `lib/wasm/` + `lib/iccs/` (pdf.js decoders for JPEG 2000, JBIG2 and ICC colour - without them such images are missing from the page)

## Deploy
Upload everything in this folder to the root of the repo (or any web server folder).
GitHub Pages: Settings -> Pages -> Deploy from a branch -> `main` / `(root)`.

## Notes
After changing any file, bump `CACHE` in `sw.js` (e.g. `dualnote-v15`) so devices pick up the update.
If you add or remove files, update `precache.json`.

## Text direction and alignment
Text and note items can carry `dir` (`ltr`/`rtl`) and `align` (`left`/`center`/`right`) - two separate properties - and text boxes a
fixed width `w`. Items without them (older files) keep the old behaviour. PDF and notebook pages share the same continuous
page column (`js/panel.js`).

## Workspace types (Layout menu)
The Layout menu chooses the structure of the workspace: `PDF Only`, `Notebook Only`, `PDF + Notebook` (default for new
workspaces) or `Notebook + PDF`. The type is stored in `manifest.workspace_type` (and `settings.window.layout`) of the `.dnws`
file. A PDF-only file has no `notebook.json`; a notebook-only file has no `pdf/` folder. Older files without a type open as
`PDF + Notebook` unless they saved another layout. A panel that leaves the structure is never deleted: it stays in memory (and in
the automatic session backup) and returns when a layout with that panel is chosen again, but it is not written to the file.

## Board and mind map
A Board is one large canvas (4000 x 3000 units) with the normal drawing tools plus the **Mind map** menu button (Node / Link), the same button as on PDF and notebook panels. Background: white or
blackboard (the sun / moon button). Ink that is pure black (or pure white) is *drawn* in the opposite shade so it stays readable;
the saved colours never change. Mind map items: `node` (id, kind, box, text, colours, optional fill) and `conn` (from/to node ids,
style, arrow, optional label); a connector follows its nodes. Boards are saved as `board.json` / `board2.json` in a workspace and as
`.dnboard` files; PDF export renders the used area (blackboards: as shown, or print-friendly on white).

## Layouts
Up to three panels from: PDF, Notebook, Board (and a second of each). Layout menu presets + "Customize panels...".
`manifest.workspace_type` is one of pdf, notebook, board, pdf+notebook, notebook+pdf, pdf+board, notebook+board,
pdf+notebook+board or `custom` (then `settings.window.layout` lists the panel keys).

## Keyboard
All shortcuts live in `js/keys.js` (one table used by the key handler, the tooltips and the "?" list). The single key handler is
`App.onKey` in `js/app.js`; panel-specific keys are in `Panel.handleKey` / `Panel.boardKey`. Keys are matched with `keyName()`, which falls
back to the physical key on non-Latin layouts (Persian) so Ctrl+Z, P, V ... work there too. Order of precedence: open dialog > Ctrl+S >
text field (typing owns the keyboard) > keyboard-focused button (Enter / Space activate it) > open menu > shortcuts.

## Eraser
`model.erasePen()` cuts the part of a pen / marker stroke that the eraser (a swept circle, radius = Brush size / 2, cut at r + stroke width / 2) covers and
returns the remaining pieces; `Panel.eraseAt()` applies it per pointer move. A whole drag is one undo step. Other item types are removed whole, as before.

## Touch tooltips
`js/tips.js`: on touch / pen, holding a toolbar button for ~0.5 s shows its `title` (+ name) in a bubble; the release then does not click the button.
Mouse users keep the browser's own tooltip.

## Mind map on every panel
Nodes / connectors (`node`, `conn` items) live in the page's item list on PDF, notebook and board panels; connectors reference node ids and are drawn between them
(also in exports). Node text is wrapped like the text box (long words are broken between letters) and a node always grows to fit its text.
