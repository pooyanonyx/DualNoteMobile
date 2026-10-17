// PDF input/output: pdf.js for viewing, pdf-lib for writing the annotated PDF.
// Annotated PDFs embed the original PDF + the editable annotations (same attachment names as the
// Windows app), so a PDF saved here reopens editable in both apps.
import * as M from "./model.js";
import { renderPage, preloadImages } from "./render.js";

let pdfjs = null;
export async function initPdfjs() {
  if (!pdfjs) {
    pdfjs = await import("../lib/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../lib/pdf.worker.min.mjs", import.meta.url).href;
  }
  return pdfjs;
}
const LIB = (p) => new URL("../lib/" + p, import.meta.url).href;

async function openRaw(bytes) {
  const lib = await initPdfjs();
  const task = lib.getDocument({ data: bytes.slice(), cMapUrl: LIB("cmaps/"), cMapPacked: true,
    standardFontDataUrl: LIB("standard_fonts/"), isEvalSupported: false });
  try { return await task.promise; } catch (e) {
    if (e && e.name === "PasswordException") throw new Error("Password-protected PDFs are not supported.");
    throw new Error("Could not open this file as a PDF.");
  }
}

/** Open PDF bytes. If the file was saved by DualNote, the embedded original + editable annotations are used.
 *  detectEmbedded=false is used for workspaces (they carry the annotations themselves). */
export async function loadDocument(bytes, { detectEmbedded = true } = {}) {
  let source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let doc = await openRaw(source), pages = null;
  if (doc.numPages < 1) { await doc.destroy(); throw new Error("This file is not a usable PDF document."); }
  if (detectEmbedded) {
    try {
      const att = await doc.getAttachments();
      const a = att && att[M.EMBED_SRC], j = att && att[M.EMBED_JSON];
      if (a && j) {
        const src2 = new Uint8Array(a.content);
        const doc2 = await openRaw(src2);
        const parsed = M.parsePdfAnnotations(j.content, doc2.numPages);
        if (parsed) { await doc.destroy(); doc = doc2; source = src2; pages = parsed; } else await doc2.destroy();
      }
    } catch { pages = null; }
  }
  return { doc, source, pages };
}

const sizeCache = new WeakMap();
export async function pageSize(doc, i) {
  let m = sizeCache.get(doc);
  if (!m) sizeCache.set(doc, (m = new Map()));
  if (!m.has(i)) { const p = await doc.getPage(i + 1); const v = p.getViewport({ scale: 1 }); m.set(i, [v.width, v.height]); }
  return m.get(i);
}

/** Render page i at 'scale' into a new canvas. Returns {canvas, cancel}. */
export function renderRaster(doc, i, scale) {
  let task = null, cancelled = false;
  const promise = (async () => {
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    if (cancelled) return null;
    task = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, canvas });
    try { await task.promise; } catch (e) { if (cancelled || (e && e.name === "RenderingCancelledException")) return null; throw e; }
    return canvas;
  })();
  return { promise, cancel() { cancelled = true; try { task && task.cancel(); } catch { /* ignore */ } } };
}

const wordCache = new WeakMap();
/** Words of page i with boxes in page points (top-left origin), in reading order: [{x0,y0,x1,y1,line}] */
export async function pageWords(doc, i) {
  let m = wordCache.get(doc);
  if (!m) wordCache.set(doc, (m = new Map()));
  if (m.has(i)) return m.get(i);
  const lib = await initPdfjs();
  const page = await doc.getPage(i + 1), vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const words = []; let line = 0, lastBase = null;
  for (const it of tc.items) {
    if (!it.str || !it.str.trim() || !it.transform) continue;
    const t = lib.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(t[2], t[3]) || 1, x = t[4], base = t[5], width = it.width * vp.scale;
    if (lastBase !== null && Math.abs(base - lastBase) > fh * 0.5) line++;
    lastBase = base;
    const len = it.str.length;
    for (const m2 of it.str.matchAll(/\S+/g)) {
      words.push({ x0: x + width * (m2.index / len), x1: x + width * ((m2.index + m2[0].length) / len),
        y0: base - fh * 0.95, y1: base + fh * 0.25, line });
    }
  }
  m.set(i, words);
  return words;
}

const pngBytes = async (canvas) => new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, "image/png"))).arrayBuffer());
function pickScale(w, h, want = 3) {
  let s = want;
  while (w * s * h * s > 16e6 && s > 1) s -= 0.25;
  return s;
}

/** Write a copy of the PDF with the annotations drawn on top (as images) plus the embedded editable data. */
export async function exportAnnotatedPdf(source, pagesItems, onProgress = () => {}) {
  const { PDFDocument, degrees } = globalThis.PDFLib;
  const out = await PDFDocument.load(source, { updateMetadata: false });
  const pages = out.getPages();
  if (pages.length !== pagesItems.length) throw new Error("Annotation data does not match the PDF page count.");
  const todo = pagesItems.map((it, i) => (it.length ? i : -1)).filter((i) => i >= 0);
  let done = 0;
  for (const i of todo) {
    const items = pagesItems[i];
    const pg = pages[i], rot = ((pg.getRotation().angle % 360) + 360) % 360, box = pg.getCropBox();
    const cw = box.width, ch = box.height, dw = rot % 180 ? ch : cw, dh = rot % 180 ? cw : ch;   // displayed size
    await preloadImages(items);
    const canvas = document.createElement("canvas");
    renderPage(canvas, dw, dh, items, { scale: pickScale(dw, dh) });
    const img = await out.embedPng(await pngBytes(canvas));
    canvas.width = canvas.height = 1;
    const place = { 0: { x: box.x, y: box.y, width: cw, height: ch },
      90: { x: box.x + cw, y: box.y, width: dw, height: dh, rotate: degrees(90) },
      180: { x: box.x + cw, y: box.y + ch, width: cw, height: ch, rotate: degrees(180) },
      270: { x: box.x, y: box.y + ch, width: dw, height: dh, rotate: degrees(270) } }[rot];
    pg.drawImage(img, place);
    onProgress(++done / todo.length);
    await new Promise((r) => setTimeout(r));                // let the UI breathe on phones
  }
  const enc = new TextEncoder();
  await out.attach(source, M.EMBED_SRC, { mimeType: "application/pdf", description: "Original PDF (DualNote)" });
  await out.attach(enc.encode(M.pdfAnnotationsToJson(pagesItems)), M.EMBED_JSON,
    { mimeType: "application/json", description: "Editable annotations (DualNote)" });
  return out.save();
}

/** Export notebook pages as an A4 PDF (pages drawn as images with the paper). */
export async function exportNotebookPdf(pages, onProgress = () => {}) {
  const { PDFDocument } = globalThis.PDFLib;
  const out = await PDFDocument.create();
  let n = 0;
  for (const p of pages) {
    await preloadImages(p.items);
    const canvas = document.createElement("canvas");
    renderPage(canvas, M.PAGE_W, M.PAGE_H, p.items, { paper: p.paper, scale: pickScale(M.PAGE_W, M.PAGE_H) });
    const img = await out.embedPng(await pngBytes(canvas));
    canvas.width = canvas.height = 1;
    const pg = out.addPage([M.PAGE_W, M.PAGE_H]);
    pg.drawImage(img, { x: 0, y: 0, width: M.PAGE_W, height: M.PAGE_H });
    onProgress(++n / pages.length);
    await new Promise((r) => setTimeout(r));
  }
  return out.save();
}
