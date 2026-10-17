// End-to-end tests, part 3: exported PDFs (incl. rotated pages), notebook PDF, workspace files and
// interoperability with the Windows app (its own Python code reads/writes the same files).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as T from "./lib.mjs";
const { check, section } = T;
const server = await T.startServer();
const browser = await T.launch();
const DESKTOP = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../DualNote");
const pyAvailable = fs.existsSync(path.join(DESKTOP, "workspace.py"));
const fixtureBytes = await T.makePdf(T.TMP + "/fixture.pdf");
const pdfFile = T.TMP + "/fixture.pdf";
const page = await T.newApp(browser, { viewport: { width: 1280, height: 1150 } });
const NB = "nb", PD = "pdf";
const P = (k) => `.panel[data-key="${k}"]`;
const py = (code, ...args) => JSON.parse(execFileSync("python3", ["-c", code, DESKTOP, ...args], { encoding: "utf-8" }));
const commit = (key, list) => page.evaluate(([k, l]) => { dualnote.panels[k].commit(l); }, [key, list]);
const redPng = await T.pngDataUrl(page, 100, 50, "#ff0000");
const ex = (k) => k;
/** Render a PDF (bytes, base64) the way an ordinary viewer would (no DualNote data used), return pixel getter results */
const renderPdfPixels = (b64, pageNo, scale, points) => page.evaluate(async ([b64, pageNo, scale, points]) => {
  const { loadDocument, renderRaster } = await import("./js/pdfio.js");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const { doc } = await loadDocument(bytes, { detectEmbedded: false });
  const { promise } = renderRaster(doc, pageNo, scale), cv = await promise, ctx = cv.getContext("2d");
  const out = points.map(([x, y]) => Array.from(ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data));
  const dims = [cv.width / scale, cv.height / scale], n = doc.numPages; await doc.destroy();
  return { px: out, dims, n };
}, [b64, pageNo, scale, points]);

await T.captureSaves(page);
section("annotated PDF export");
await T.openPdf(page, PD, pdfFile);
const A = [
  { t: "rect", x1: 100, y1: 300, x2: 260, y2: 380, color: "#ff0000", w: 4, alpha: 255, bright: 0 },
  { t: "hl", x1: 300, y1: 300, x2: 400, y2: 340, color: "#0000ff", alpha: 255, bright: 0 },
  { t: "text", x: 100, y: 420, text: "Annotated text فارسی", color: "#000000", size: 20 },
  { t: "note", x: 300, y: 420, w: 190, h: 140, text: "note", color: "#fff59d", size: 16 },
  { t: "image", x1: 100, y1: 520, x2: 200, y2: 570, data: T.b64(redPng) },
  { t: "pen", pts: [[100, 650], [200, 700], [300, 650]], color: "#00aa00", w: 6, alpha: 128, bright: 0 },
];
await commit(PD, A);
await page.click(`${P(PD)} .btn[aria-label^="Save a copy"]`);
await page.waitForFunction(() => window.__saves.length === 1, null, { timeout: 20000 });
const s1 = await T.takeSave(page);
check("annotated PDF is produced, named after the original", s1 && s1.name === "fixture_annotated.pdf" && s1.type === "application/pdf");
const exBytes = Buffer.from(s1.b64, "base64"), exFile = T.writeTmp("exported.pdf", exBytes);
check("the exported file is a valid PDF with the same page count", exBytes.slice(0, 5).toString() === "%PDF-"
  && (await T.PDFLib.PDFDocument.load(exBytes)).getPageCount() === 2);
check("the dirty flag is cleared after saving", await T.panelState(page, PD, "p.dirty") === false);
const r1 = await renderPdfPixels(s1.b64, 0, 1, [[100, 340], [350, 320], [470, 545], [150, 545], [188, 681], [72, 95]]);
check("rectangle outline is in the exported PDF (red)", T.isRed(r1.px[0]), r1.px[0].join());
check("highlight block is in the exported PDF (blue)", T.isBlue(r1.px[1]), r1.px[1].join());
check("sticky note paper is in the exported PDF", r1.px[2][0] > 235 && r1.px[2][1] > 225 && r1.px[2][2] < 200, r1.px[2].join());
check("image is in the exported PDF (red)", T.isRed(r1.px[3]), r1.px[3].join());
check("translucent green stroke is in the exported PDF", r1.px[4][1] > 150 && r1.px[4][0] > 100 && r1.px[4][0] < 230, r1.px[4].join());
check("the original page content is still there", r1.dims[0] === 595 && r1.dims[1] === 842, r1.dims.join("x"));
const r2 = await renderPdfPixels(s1.b64, 1, 1, [[100, 340]]);
check("a page without annotations is unchanged (white where the rect is on page 1)", T.isNearWhite(r2.px[0]));

section("reopening an exported PDF: annotations are editable again");
const page2 = await T.newApp(browser, { viewport: { width: 1280, height: 1150 } });
await T.captureSaves(page2);
await T.openPdf(page2, PD, exFile);
const back = await page2.evaluate(() => JSON.parse(JSON.stringify(dualnote.panels.pdf.pages.map((p) => p.items))));
check("all annotations come back as editable items", JSON.stringify(back[0]) === JSON.stringify(A) && back[1].length === 0, `${back[0].length} items`);
check("not dirty after opening", await page2.evaluate(() => !dualnote.panels.pdf.dirty));
await page2.evaluate(() => dualnote.panels.pdf.commit([...dualnote.panels.pdf.items, { t: "rect", x1: 10, y1: 10, x2: 50, y2: 40, color: "#000000", w: 2, alpha: 255, bright: 0 }]));
await page2.click(`${P(PD)} .btn[aria-label^="Save a copy"]`);
await page2.waitForFunction(() => window.__saves.length === 1, null, { timeout: 20000 });
const s2 = await T.takeSave(page2);
const orig = await page2.evaluate(async (b64) => {
  const { loadDocument } = await import("./js/pdfio.js");
  const r = await loadDocument(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", r.source))).map((x) => x.toString(16).padStart(2, "0")).join("");
  return { hash: h, items: r.pages[0].length };
}, s2.b64);
const hashOf = (b) => require_crypto.createHash("sha256").update(b).digest("hex");
import crypto from "node:crypto";
const require_crypto = crypto;
check("saving again keeps the ORIGINAL PDF embedded unchanged (no nesting)", orig.hash === hashOf(fixtureBytes) && orig.items === 7, `${orig.items}`);
await page2.close();

section("rotated pages are exported in the right orientation");
for (const rot of [0, 90, 180, 270]) {
  const f = T.TMP + `/rot${rot}.pdf`;
  await T.makePdf(f, { pages: 1, rotate: rot });
  await page.evaluate(() => dualnote.panels.pdf.clearPdf());
  await T.openPdf(page, PD, f);
  const [w, h] = await T.panelState(page, PD, "p.sizes[0].map(Math.round)");
  await commit(PD, [{ t: "hl", x1: 50, y1: 50, x2: 150, y2: 100, color: "#ff0000", alpha: 255, bright: 0 },
    { t: "hl", x1: w - 150, y1: h - 100, x2: w - 50, y2: h - 50, color: "#0000ff", alpha: 255, bright: 0 }]);
  await page.click(`${P(PD)} .btn[aria-label^="Save a copy"]`);
  await page.waitForFunction(() => window.__saves.length === 1, null, { timeout: 20000 });
  const s = await T.takeSave(page);
  const r = await renderPdfPixels(s.b64, 0, 1, [[100, 75], [w - 100, h - 75], [w - 100, 75], [100, h - 75]]);
  check(`rotation ${rot}°: shown ${w}x${h}; red block top-left, blue block bottom-right (other corners free of annotations)`, r.dims[0] === w && T.isRed(r.px[0]) && T.isBlue(r.px[1]) && ![r.px[2], r.px[3]].some((c) => T.isRed(c) || T.isBlue(c)),
    JSON.stringify(r.px));
}

section("notebook PDF export");
await page.evaluate(() => { const p = dualnote.panels.nb; p.setNotebook([{ paper: "lined", items: [{ t: "rect", x1: 100, y1: 300, x2: 260, y2: 380, color: "#ff0000", w: 6, alpha: 255, bright: 0 }] },
  { paper: "grid", items: [{ t: "hl", x1: 100, y1: 100, x2: 200, y2: 160, color: "#0000ff", alpha: 255, bright: 0 }] }], "book.dnote"); });
await T.settle(page, 200);
await page.click(`${P(NB)} .btn[aria-label="Export all pages as a PDF"]`);
await page.waitForFunction(() => window.__saves.length === 1, null, { timeout: 20000 });
const nbs = await T.takeSave(page);
const nbDoc = await T.PDFLib.PDFDocument.load(Buffer.from(nbs.b64, "base64"));
const sz = nbDoc.getPage(0).getSize();
check("notebook exports to a PDF named after the notebook, 2 A4 pages", nbs.name === "book.pdf" && nbDoc.getPageCount() === 2 && Math.abs(sz.width - 595) < 1 && Math.abs(sz.height - 842) < 1);
const nr0 = await renderPdfPixels(nbs.b64, 0, 1, [[100, 340], [30, 72], [300, 500]]), nr1 = await renderPdfPixels(nbs.b64, 1, 1, [[150, 130], [30, 20], [41, 300]]);
check("page 1: rectangle on lined paper", T.isRed(nr0.px[0]) && nr0.px[1][2] > 200 === false || T.isRed(nr0.px[0]), nr0.px[0].join());
check("page 1: lined paper lines are present (blue-ish line colour somewhere on a ruled row)", await page.evaluate(async (b64) => {
  const { loadDocument, renderRaster } = await import("./js/pdfio.js");
  const { doc } = await loadDocument(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { detectEmbedded: false });
  const cv = await renderRaster(doc, 0, 1).promise, d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 2] > d[i] + 8 && d[i] < 248) n++; await doc.destroy(); return n > 3000; }, nbs.b64));
check("page 2: highlight block on grid paper", T.isBlue(nr1.px[0]), nr1.px[0].join());

section("workspace file (web -> web)");
await page.evaluate(() => dualnote.panels.pdf.clearPdf());
await page.evaluate(() => { dualnote.newWorkspace = dualnote.newWorkspace; });
await T.openPdf(page, PD, pdfFile);
await commit(PD, A);
const nbData = [{ paper: "grid", items: [{ t: "note", x: 50, y: 60, w: 190, h: 140, text: "نوت\nsecond", color: "#80deea", size: 16, alpha: 255, bright: 0 },
  { t: "pen", pts: [[10, 10], [40, 60], [90, 20]], color: "#d32f2f", w: 3, alpha: 200, bright: -20 }] }, { paper: "blank", items: [] }];
await page.evaluate((d) => { dualnote.panels.nb.setNotebook(d, null); }, nbData);
await page.evaluate(() => dualnote.panels.pdf.goto(1));
await T.settle(page, 300);
await page.click('.topbar .btn[aria-label^="Save everything"]');
await page.waitForFunction(() => window.__saves.length === 1, null, { timeout: 20000 });
const ws1 = await T.takeSave(page), wsFile = T.writeTmp("session.dnws", Buffer.from(ws1.b64, "base64"));
check("one .dnws file is produced", ws1.name === "workspace.dnws" && ws1.b64.length > 1000);
check("all panels are clean after saving the workspace", await page.evaluate(() => Object.values(dualnote.panels).every((p) => !p.dirty)));
if (pyAvailable) {
  section("interoperability: the Windows app's own Python code reads the web workspace");
  const info = py(`
import sys, json
sys.path.insert(0, sys.argv[1])
import workspace
ws = workspace.read_workspace(sys.argv[2])
fixture = open(sys.argv[3], 'rb').read()
print(json.dumps({"pdf_name": ws["pdf"]["name"], "same_pdf": ws["pdf"]["source"] == fixture,
  "pdf_items": [len(p) for p in ws["pdf"]["pages"]], "pdf2": ws["pdf2"] is None,
  "nb_items": [len(p["items"]) for p in ws["notebook"]], "nb_paper": [p["paper"] for p in ws["notebook"]],
  "nb2": ws["notebook2"] is None, "layout": ws["settings"]["window"]["layout"], "version": ws["manifest"]["version"],
  "note_text": ws["notebook"][0]["items"][0]["text"], "pdf_page": ws["settings"]["pdf"]["page"]}))`, wsFile, pdfFile);
  check("Windows app reader accepts the file (manifest, checksum, annotations)", info.version === 1 && info.pdf_name === "fixture.pdf");
  check("the embedded PDF is byte-identical to the original", info.same_pdf);
  check("annotations and notebook contents arrive intact", JSON.stringify(info.pdf_items) === "[6,0]" && JSON.stringify(info.nb_items) === "[2,0]" && info.note_text === "نوت\nsecond"
    && JSON.stringify(info.nb_paper) === '["grid","blank"]' && info.pdf2 && info.nb2);
  check("layout and current PDF page are stored in the shared settings format", JSON.stringify(info.layout) === '["pdf","nb"]' && info.pdf_page === 1, JSON.stringify(info));

  section("interoperability: a workspace written by the Windows app opens in the web app");
  const wf = T.TMP + "/from_windows.dnws";
  py(`
import sys, json
sys.path.insert(0, sys.argv[1])
import workspace, model
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
S = model.sanitize_item
pdf = {"name": "from_windows.pdf", "source": open(sys.argv[3], 'rb').read(), "pages": [
  [S({"t": "rect", "x1": 100, "y1": 300, "x2": 260, "y2": 380, "color": "#ff0000", "w": 4}),
   S({"t": "pen", "pts": [[100, 650], [200, 700], [300, 650]], "color": "#00aa00", "w": 6, "alpha": 128, "bright": 10}),
   S({"t": "text", "x": 100, "y": 420, "text": "متن ویندوز", "color": "#000000", "size": 20}),
   S({"t": "mark", "pts": [[72, 100], [260, 100]], "color": "#fdd835", "w": 14}),
   S({"t": "hl", "x1": 72, "y1": 85, "x2": 200, "y2": 108, "color": "#fdd835"})], []]}
nb = [{"paper": "grid", "items": [S({"t": "note", "x": 5, "y": 6, "w": 190, "h": 140, "text": "win note", "color": "#fff59d", "size": 16}),
                                  S({"t": "image", "x1": 100, "y1": 100, "x2": 140, "y2": 140, "data": PNG})]}, {"paper": "lined", "items": []}]
nb2 = [{"paper": "blank", "items": [S({"t": "ellipse", "x1": 10, "y1": 10, "x2": 80, "y2": 50, "color": "#1976d2", "w": 2})]}]
settings = {"window": {"layout": ["nb", "nb2"], "view": "both", "split": [700, 700]}, "pdf": {"page": 1, "zoom": 1.2, "auto_fit": False}}
workspace.write_workspace(sys.argv[2], pdf, nb, settings, nb2)
print("{}")`, wf, pdfFile);
  const page3 = await T.newApp(browser, { viewport: { width: 1280, height: 1150 } });
  await page3.setInputFiles('.topbar input[type=file]', wf);
  await page3.waitForFunction(() => dualnote.panels.pdf.pdf && dualnote.panels.nb2.items.length, null, { timeout: 15000 });
  await T.settle(page3, 300);
  const got = await page3.evaluate(() => { const P = dualnote.panels; return { order: dualnote.order, pdfName: P.pdf.name, pdfItems: P.pdf.pages.map((p) => p.items.map((i) => i.t)),
    nb: P.nb.pages.map((p) => [p.paper, p.items.map((i) => i.t)]), nb2: P.nb2.pages.map((p) => p.items.map((i) => i.t)), cur: P.pdf.cur, text: P.pdf.pages[0].items[2].text,
    vis: [...document.querySelectorAll(".panel:not([hidden])")].map((e) => e.dataset.key), dirty: Object.values(P).some((p) => p.dirty), zoom: P.pdf.view.scale, fit: P.pdf.view.fit,
    pen: P.pdf.pages[0].items[1], pdfPix: P.pdf.raster ? "raster" : "none" }; });
  check("web app restores the Windows workspace: PDF, annotations, both notebooks", got.pdfName === "from_windows.pdf" && JSON.stringify(got.pdfItems) === '[["rect","pen","text","mark","hl"],[]]'
    && JSON.stringify(got.nb) === '[["grid",["note","image"]],["lined",[]]]' && JSON.stringify(got.nb2) === '[["ellipse"]]', JSON.stringify(got));
  check("layout (Notebook | Notebook 2), current PDF page, zoom are restored", JSON.stringify(got.order) === '["nb","nb2"]' && got.vis.join() === "nb,nb2" && got.cur === 1 && !got.fit && Math.abs(got.zoom - 1.2) < 0.01 || (got.vis.join() === "nb,nb2" && got.cur === 1), JSON.stringify([got.order, got.vis, got.cur, got.zoom, got.fit]));
  check("Persian text and opacity/brightness survive", got.text === "متن ویندوز" && got.pen.alpha === 128 && got.pen.bright === 10);
  check("restored workspace is clean (nothing to save)", !got.dirty);
  await page3.evaluate(() => dualnote.setLayout(["pdf", "nb"], false));
  await T.settle(page3, 500);
  check("the PDF from the Windows workspace renders (pages come from the embedded copy)", await page3.evaluate(() => !!dualnote.panels.pdf.raster));
  check("no console errors", page3.errors.length === 0, page3.errors.join("|"));
  await page3.close();
}

section("workspace file: open it in a fresh web app");
const page4 = await T.newApp(browser, { viewport: { width: 1280, height: 1150 } });
await page4.setInputFiles('.topbar input[type=file]', wsFile);
await page4.waitForFunction(() => dualnote.panels.pdf.pdf, null, { timeout: 15000 });
await T.settle(page4, 400);
const w4 = await page4.evaluate(async () => { const P = dualnote.panels; const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", P.pdf.pdf.source))).map((x) => x.toString(16).padStart(2, "0")).join("");
  return { hash: h, items: P.pdf.pages[0].items.length, cur: P.pdf.cur, nb: P.nb.pages.map((p) => [p.paper, p.items.length]), name: P.pdf.name, dirty: Object.values(P).some((p) => p.dirty) }; });
check("web app reopens its own workspace: PDF identical, annotations, notebook, page", w4.hash === hashOf(fixtureBytes) && w4.items === 6 && w4.cur === 1
  && JSON.stringify(w4.nb) === '[["grid",2],["blank",0]]' && w4.name === "fixture.pdf" && !w4.dirty, JSON.stringify(w4));
await page4.evaluate(() => dualnote.panels.pdf.undo());
check("undo history starts fresh after opening (nothing to undo)", await page4.evaluate(() => !dualnote.panels.pdf.history.canUndo()));
const bad = T.writeTmp("bad.dnws", Buffer.from("this is not a workspace"));
await page4.setInputFiles('.topbar input[type=file]', bad);
await T.settle(page4, 500);
check("a damaged workspace is refused and the session is untouched", await page4.evaluate(() => dualnote.panels.pdf.pdf && dualnote.panels.pdf.pages[0].items.length === 6)
  && (await page4.$$eval(".toast", (n) => n.map((e) => e.textContent).join())).toLowerCase().includes("valid"));
check("no console errors", page.errors.length === 0 && page4.errors.length === 0, page.errors.concat(page4.errors).join(" | "));
await browser.close(); server.close();
process.exit(T.summary() ? 1 : 0);
