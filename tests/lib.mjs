// Shared helpers for the end-to-end tests (real headless Chromium via Playwright).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const HERE = path.dirname(new URL(import.meta.url).pathname);
// find playwright / pdf-lib in the project's node_modules (npm install) or in a global install
const ROOTS = [path.resolve(HERE, "..") + "/", process.cwd() + "/", "/home/claude/.npm-global/lib/node_modules/"];
function need(name) {
  for (const r of ROOTS) { try { return createRequire(r + "x.js")(name); } catch { /* try next */ } }
  throw new Error(`Cannot find "${name}". Run:  npm install  (in the DualNoteMobile folder) and  npx playwright install chromium`);
}
export const require = need;
export const { chromium } = need("playwright");
export const PDFLib = need("pdf-lib");
import http from "node:http";
export let URL_ = process.env.DN_URL || "";
export const TMP = fs.mkdtempSync("/tmp/dn-e2e-");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".pfb": "application/octet-stream", ".bcmap": "application/octet-stream", ".pdf": "application/pdf" };
/** Serve ../www on a free local port (localhost counts as a secure context, like https). */
export async function startServer() {
  if (URL_) return { close() {} };
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../www");
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  URL_ = `http://localhost:${server.address().port}/`;
  return { close: () => server.close(), url: URL_ };
}

let passed = 0, failed = 0;
export function check(name, cond, extra = "") {
  if (cond) { passed++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (extra !== "" ? "   [" + extra + "]" : "")); }
}
export function summary() { console.log(`\n${passed + failed} checks, ${failed} failed`); return failed; }
export const section = (s) => console.log("== " + s + " ==");

export async function launch() {
  const sandboxChrome = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const exe = process.env.CHROME_PATH || (fs.existsSync(sandboxChrome) ? sandboxChrome : undefined);
  return chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
}
/** New app page. opts: viewport, touch. Collects console errors in page.errors. */
export async function newApp(browser, opts = {}) {
  const ctx = opts.ctx || await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 800 }, deviceScaleFactor: opts.dpr || 1,
    hasTouch: !!opts.touch, isMobile: !!opts.touch, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"], serviceWorkers: opts.sw ? "allow" : "block" });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("console", (m) => { if (m.type() === "error") page.errors.push(m.text()); });
  page.on("pageerror", (e) => page.errors.push("pageerror: " + e.message));
  await page.goto(opts.url || URL_);
  await page.waitForSelector(".panel");
  await page.waitForFunction(() => window.dualnote);
  await page.waitForTimeout(200);
  page.ctx = ctx;
  return page;
}
export const settle = (page, ms = 250) => page.waitForTimeout(ms);

// ------------------------------------------------------------- fixtures
export async function makePdf(file, { pages = 2, rotate = 0, size = [595, 842], text = "Hello DualNote original text" } = {}) {
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const pg = doc.addPage(size);
    pg.drawText(i === 0 ? text : `Page ${i + 1} body text`, { x: 72, y: size[1] - 100, size: 18, font, color: rgb(0, 0, 0) });
    pg.drawText("Second line of the first page for highlighting", { x: 72, y: size[1] - 130, size: 14, font, color: rgb(0, 0, 0) });
    if (rotate) pg.setRotation(degrees(rotate));
  }
  const bytes = await doc.save();
  fs.writeFileSync(file, bytes);
  return Buffer.from(bytes);
}
export const fileInput = (key, image = false) => `.panel[data-key="${key}"] input[type=file]${image ? '[accept="image/*"]' : ':not([accept="image/*"])'}`;
export async function openPdf(page, key, file) {
  await page.setInputFiles(fileInput(key), file);
  await page.waitForFunction((k) => { const p = dualnote.panels[k]; return p.pdf && p.sizes[p.cur] && p.raster; }, key, { timeout: 15000 });
  await settle(page, 150);
}
// --------------------------------------------------------- page helpers
export const items = (page, key) => page.evaluate((k) => JSON.parse(JSON.stringify(dualnote.panels[k].items)), key);
export const panelState = (page, key, expr) => page.evaluate(([k, e]) => { const p = dualnote.panels[k]; return new Function("p", "return " + e)(p); }, [key, expr]);
/** page coordinates -> client coordinates for a panel */
export const toClient = (page, key, x, y) => page.evaluate(([k, x, y]) => {
  const p = dualnote.panels[k], r = p.stage.getBoundingClientRect();
  return [r.left + p.view.tx + x * p.view.scale, r.top + p.view.ty + y * p.view.scale];
}, [key, x, y]);
export async function drag(page, key, a, b, steps = 8) {
  const [x0, y0] = await toClient(page, key, a[0], a[1]), [x1, y1] = await toClient(page, key, b[0], b[1]);
  await page.mouse.move(x0, y0); await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
  await page.mouse.up(); await settle(page, 60);
}
export async function tap(page, key, p) {
  const [x, y] = await toClient(page, key, p[0], p[1]);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up(); await settle(page, 60);
}
export const setTool = (page, key, tool) => page.click(`.panel[data-key="${key}"] .btn.tool[aria-label="${{ select: "Select", pen: "Pen", mark: "Marker", hltext: "Highlight", eraser: "Eraser", text: "Text", note: "Note", line: "Line", arrow: "Arrow", rect: "Rect", ellipse: "Circle", pan: "Hand" }[tool]}"]`);
/** Pixel colour on the panel canvas at page coordinates (reads the real canvas pixels). */
export const pixelAt = (page, key, x, y) => page.evaluate(([k, x, y]) => {
  const p = dualnote.panels[k]; p.draw();
  const sx = Math.round((p.view.tx + x * p.view.scale) * p.dpr), sy = Math.round((p.view.ty + y * p.view.scale) * p.dpr);
  return Array.from(p.ctx.getImageData(sx, sy, 1, 1).data);
}, [key, x, y]);
export const isRed = (c) => c[0] > 190 && c[1] < 90 && c[2] < 90;
export const isBlue = (c) => c[2] > 150 && c[0] < 90 && c[1] < 120;
export const isNearWhite = (c) => c.slice(0, 3).every((v) => v > 240);
/** PNG data URL of a solid-colour image (for paste tests) */
export const pngDataUrl = (page, w, h, color) => page.evaluate(([w, h, c]) => { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const x = cv.getContext("2d"); x.fillStyle = c; x.fillRect(0, 0, w, h); return cv.toDataURL("image/png"); }, [w, h, color]);
export const b64 = (dataUrl) => dataUrl.split(",")[1];
export const writeTmp = (name, buf) => { const f = path.join(TMP, name); fs.writeFileSync(f, buf); return f; };
/** Capture what the app wants to save (instead of downloading). */
export const captureSaves = (page) => page.evaluate(() => {
  window.__saves = [];
  dualnote.saveBlob = async (blob, name) => { window.__saves.push({ name, blob }); };
});
export const takeSave = (page) => page.evaluate(async () => {
  const s = window.__saves.shift(); if (!s) return null;
  const buf = new Uint8Array(await s.blob.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { name: s.name, type: s.blob.type, b64: btoa(bin) };
});
