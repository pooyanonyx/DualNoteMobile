// Drawing of DualNote items to a 2D canvas. The same code draws on screen and for PDF export,
// so what you see is what you export. Units are page points (1 pt = 1 user unit of the canvas).
import * as M from "./model.js";

// Vazirmatn (bundled, see css/app.css) covers the Arabic script block so Persian looks the same on every device.
export const FONT_STACK = 'Vazirmatn, "Segoe UI", Roboto, "Noto Sans", "Noto Naskh Arabic", Tahoma, sans-serif';
const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR_RE = /[A-Za-z]/;
export const TEXT_PAD = 4;

export function isRtl(line) {                                // direction of the first strong letter
  for (const ch of line) { if (RTL_RE.test(ch)) return true; if (LTR_RE.test(ch)) return false; }
  return false;
}

// ---------------------------------------------------------------- measuring
let _mctx = null;
export function measureCtx() {
  if (!_mctx) _mctx = document.createElement("canvas").getContext("2d");
  return _mctx;
}
/** Explicit {dir, align} of a text / note item, or null for old items (direction then detected per line). */
export function fmtOf(d) {
  if (d.dir !== "rtl" && d.dir !== "ltr") return null;
  return { dir: d.dir, align: d.align === "center" || d.align === "right" || d.align === "left" ? d.align : (d.dir === "rtl" ? "right" : "left") };
}
/** What the format buttons show for an item: its explicit format, or the one implied by its first strong letter. */
export function effectiveFmt(d) {
  const f = fmtOf(d);
  if (f) return f;
  const rtl = isRtl(String(d.text || ""));
  return { dir: rtl ? "rtl" : "ltr", align: rtl ? "right" : "left" };
}
/** Break text into lines. maxWidth = null: only explicit newlines. fmt: explicit {dir, align} or null. */
export function layoutText(ctx, text, size, maxWidth = null, fmt = null) {
  ctx.font = `${size}px ${FONT_STACK}`;
  const lh = size * 1.25, lines = [];
  const push = (s) => lines.push({ text: s, w: ctx.measureText(s).width, rtl: fmt ? fmt.dir === "rtl" : isRtl(s) });
  for (const para of String(text).split("\n")) {
    if (maxWidth == null) { push(para); continue; }
    let cur = "";
    for (const word of para.split(" ")) {
      const test = cur ? cur + " " + word : word;
      if (!cur || ctx.measureText(test).width <= maxWidth) cur = test;
      else { push(cur); cur = word; }
    }
    push(cur);
  }
  return { lines, lh, width: Math.max(0, ...lines.map((l) => l.w)), height: lines.length * lh };
}
/** Width available for the lines of a text item with a fixed box width (null = unlimited, old behaviour). */
export function textInnerWidth(d) { return d.w ? Math.max(10, d.w - 2 * TEXT_PAD) : null; }
/** [x0, y0, x1, y1] of a text item (including its padding). */
export function textBox(d) {
  const mw = textInnerWidth(d), L = layoutText(measureCtx(), d.text, d.size, mw, fmtOf(d));
  return [d.x, d.y, d.x + (mw ? mw : L.width) + 2 * TEXT_PAD, d.y + L.height + 2 * TEXT_PAD];
}
export function noteTextWidth(d) { return Math.max(20, d.w - 16); }
/** Height a note needs to show all its text. */
export function noteNeededHeight(d, text = d.text) {
  const L = layoutText(measureCtx(), text, d.size, noteTextWidth(d), fmtOf(d));
  return L.height + M.NOTE_HEADER + 12;
}

// ------------------------------------------------------------------- images
const imageCache = new Map();           // base64 -> {img, ok, promise}
let onImageLoaded = () => {};
export function setImageLoadedCallback(fn) { onImageLoaded = fn; }
export function getImage(data) {
  let e = imageCache.get(data);
  if (!e) {
    const img = new Image();
    e = { img, ok: false, failed: false };
    e.promise = new Promise((resolve) => {
      img.onload = () => { e.ok = true; resolve(); onImageLoaded(); };
      img.onerror = () => { e.failed = true; resolve(); onImageLoaded(); };
    });
    img.src = "data:image/png;base64," + data;
    if (imageCache.size > 40) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(data, e);
  }
  return e;
}
export function preloadImages(items) {
  return Promise.all(items.filter((d) => d.t === "image").map((d) => getImage(d.data).promise));
}

// -------------------------------------------------------------------- paths
function strokePath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  const n = pts.length;
  if (n === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
  else if (n === 2) ctx.lineTo(pts[1][0], pts[1][1]);
  else {
    for (let i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
    }
    ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
  }
}
function linePath(ctx, d, arrow) {
  ctx.beginPath();
  ctx.moveTo(d.x1, d.y1);
  ctx.lineTo(d.x2, d.y2);
  if (arrow) {
    const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
    if (len > 0.01) {
      const head = Math.min(Math.max(10, d.w * 4), len), ang = Math.atan2(d.y2 - d.y1, d.x2 - d.x1);
      for (const s of [1, -1]) {
        const a = ang + Math.PI - s * (28 * Math.PI / 180);
        ctx.moveTo(d.x2, d.y2);
        ctx.lineTo(d.x2 + head * Math.cos(a), d.y2 + head * Math.sin(a));
      }
    }
  }
}
const mixCss = (hex, bright) => {
  const [r, g, b] = M.adjustBrightness(M.parseHex(hex) || [0, 0, 0], bright);
  return `rgb(${r},${g},${b})`;
};

// ------------------------------------------------------------------- paper
export function drawPaper(ctx, w, h, kind) {
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  if (kind === "lined") {
    ctx.strokeStyle = "#b9d3ee"; ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let y = 72; y < h - 30; y += 24) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    ctx.strokeStyle = "#eba3a3"; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(62, 0); ctx.lineTo(62, h); ctx.stroke();
  } else if (kind === "grid") {
    ctx.strokeStyle = "#cdd6e2"; ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = 20; x < w; x += 20) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = 20; y < h; y += 20) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }
  ctx.strokeStyle = "#8a8f98"; ctx.lineWidth = 0.8;
  ctx.strokeRect(0, 0, w, h);
  ctx.restore();
}

// -------------------------------------------------------------------- text
// Lines are drawn with the browser's own text engine (canvas fillText): it shapes Persian/Arabic letters and runs the
// Unicode bidi algorithm using ctx.direction as the paragraph direction. Alignment is physical (left/center/right), so
// direction and alignment are independent. fmt = null: old items (per-line detected direction, RTL lines right-aligned).
function drawTextLines(ctx, L, x, y, blockWidth, size, fill, fmt = null) {
  ctx.font = `${size}px ${FONT_STACK}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = fill;
  L.lines.forEach((ln, i) => {
    const ly = y + i * L.lh + (L.lh - size) / 2;
    const align = fmt ? fmt.align : (ln.rtl ? "right" : "left");
    ctx.direction = ln.rtl ? "rtl" : "ltr"; ctx.textAlign = align;
    const ax = align === "right" ? x + blockWidth : align === "center" ? x + blockWidth / 2 : x;
    ctx.fillText(ln.text, ax, ly);
  });
  ctx.direction = "ltr"; ctx.textAlign = "left";
}

function drawNote(ctx, d, skipText) {
  const { x, y, w, h } = d, hd = M.NOTE_HEADER, bright = M.itemBright(d);
  ctx.save();
  ctx.globalAlpha = M.itemAlpha(d) / 255;
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(0,0,0,0.22)"; ctx.fillRect(3, 4, w, h);                          // shadow
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, mixCss(d.color, Math.min(100, bright + 9))); g.addColorStop(1, mixCss(d.color, bright));
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);                                           // paper
  ctx.fillStyle = mixCss(d.color, bright - 11); ctx.fillRect(0, 0, w, hd);               // header strip
  const f = Math.min(18, w / 4, h / 4);
  ctx.fillStyle = mixCss(d.color, bright - 22);                                          // folded corner
  ctx.beginPath(); ctx.moveTo(w - f, h); ctx.lineTo(w, h - f); ctx.lineTo(w - f, h - f); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.59)"; ctx.strokeStyle = "rgba(0,0,0,0.16)"; ctx.lineWidth = 0.6;
  ctx.fillRect(w / 2 - 24, -6, 48, 14); ctx.strokeRect(w / 2 - 24, -6, 48, 14);          // piece of tape
  ctx.font = `bold 9px ${FONT_STACK}`; ctx.textBaseline = "middle"; ctx.fillStyle = "rgba(0,0,0,0.43)";
  ctx.fillText("NOTE", 8, hd / 2);
  ctx.strokeStyle = mixCss(d.color, bright - 26); ctx.lineWidth = 0.6; ctx.strokeRect(0, 0, w, h);
  if (!skipText) {
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    const bw = noteTextWidth(d), fmt = fmtOf(d), L = layoutText(ctx, d.text, d.size, bw, fmt);
    drawTextLines(ctx, L, 8, hd + 4, bw, d.size, M.noteTextColor({ color: d.color, bright }), fmt);
  }
  ctx.restore();
}

// -------------------------------------------------------------------- item
/** Draw one item. opts.skipText hides the text of an item that is being edited. */
export function drawItem(ctx, d, opts = {}) {
  const t = d.t;
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  if (t === "pen" || t === "mark") {
    ctx.strokeStyle = M.cssColor(d); ctx.lineWidth = d.w;
    ctx.lineCap = t === "mark" ? "square" : "round";
    strokePath(ctx, d.pts); ctx.stroke();
  } else if (t === "line" || t === "arrow") {
    ctx.strokeStyle = M.cssColor(d); ctx.lineWidth = d.w;
    linePath(ctx, d, t === "arrow"); ctx.stroke();
  } else if (t === "rect") {
    ctx.strokeStyle = M.cssColor(d); ctx.lineWidth = d.w; ctx.lineJoin = "miter";
    ctx.strokeRect(Math.min(d.x1, d.x2), Math.min(d.y1, d.y2), Math.abs(d.x2 - d.x1), Math.abs(d.y2 - d.y1));
  } else if (t === "ellipse") {
    ctx.strokeStyle = M.cssColor(d); ctx.lineWidth = d.w;
    ctx.beginPath();
    ctx.ellipse((d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2, Math.max(0.01, Math.abs(d.x2 - d.x1) / 2),
      Math.max(0.01, Math.abs(d.y2 - d.y1) / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (t === "hl") {
    ctx.fillStyle = M.cssColor(d);
    ctx.fillRect(Math.min(d.x1, d.x2), Math.min(d.y1, d.y2), Math.abs(d.x2 - d.x1), Math.abs(d.y2 - d.y1));
  } else if (t === "text") {
    if (!opts.skipText) {
      const mw = textInnerWidth(d), fmt = fmtOf(d), L = layoutText(ctx, d.text, d.size, mw, fmt);
      drawTextLines(ctx, L, d.x + TEXT_PAD, d.y + TEXT_PAD, mw ? mw : L.width, d.size, M.cssColor(d), fmt);
    }
  } else if (t === "note") {
    drawNote(ctx, d, opts.skipText);
  } else if (t === "image") {
    const x = Math.min(d.x1, d.x2), y = Math.min(d.y1, d.y2), w = Math.abs(d.x2 - d.x1), h = Math.abs(d.y2 - d.y1);
    const e = getImage(d.data);
    ctx.globalAlpha = M.itemAlpha(d) / 255;
    if (e.ok) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(e.img, x, y, w, h); }
    else {                                                   // not decoded (yet / ever): placeholder
      ctx.fillStyle = "#e0e0e0"; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = e.failed ? "#b00020" : "#9e9e9e"; ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      if (e.failed) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.moveTo(x + w, y); ctx.lineTo(x, y + h); ctx.stroke(); }
    }
  }
  ctx.restore();
}

/** Draw a whole page: paper (notebook) and items. Used for export; 'scale' = canvas pixels per point. */
export function renderPage(canvas, w, h, items, { paper = null, scale = 2 } = {}) {
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(scale, scale);
  if (paper) drawPaper(ctx, w, h, paper);
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();         // nothing outside the page
  for (const d of items) drawItem(ctx, d);
  ctx.restore();
  return canvas;
}
