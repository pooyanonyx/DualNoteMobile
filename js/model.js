// DualNote data model (pure JavaScript, no DOM) - a port of model.py so that files made
// by the Windows app and by this app are interchangeable.
//
// Every drawing is a small JSON object ("item") in page coordinates (PDF points):
//   pen / mark   {t, pts:[[x,y],...], color:"#rrggbb", w}
//   line / arrow {t, x1,y1,x2,y2, color, w}        rect / ellipse: same fields
//   hl           {t:"hl", x1,y1,x2,y2, color}      (text highlight box)
//   image        {t:"image", x1,y1,x2,y2, data: base64 PNG}
//   note         {t:"note", x,y,w,h, text, color (paper), size}
//   text         {t:"text", x,y, text, color, size}
// Any item may also carry alpha (0..255) and bright (-100..100).
// Items are never modified in place: an edit creates a new object (cheap undo snapshots).

export const PAGE_W = 595.0, PAGE_H = 842.0;             // notebook page = A4 in points
export const PAPERS = ["blank", "lined", "grid"];
export const NOTE_W = 190.0, NOTE_H = 140.0, NOTE_HEADER = 16.0;
export const NOTEBOOK_FORMAT = "DualNote-notebook";
export const PDF_ANNOT_FORMAT = "DualNote-pdf-annotations";
export const EMBED_SRC = "dualnote_source.pdf";
export const EMBED_JSON = "dualnote_annotations.json";
export const LEGACY_ALPHA = { mark: 110, hl: 100 };
export const MIN_SIZE = 4.0;
export const TEXT_DIRS = ["ltr", "rtl"];                    // explicit text direction of a text / note item
export const TEXT_ALIGNS = ["left", "center", "right"];     // explicit alignment (separate from direction)
export const TEXT_BOX_W = 300.0;                              // default width of a new text box
export const LAYOUT_KEYS = ["pdf", "pdf2", "nb", "nb2"];
export const DEFAULT_LAYOUT = ["pdf", "nb"];

// Python's round() (half to even) so colours match the Windows app exactly.
export function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = (v) => Math.round(v * 100) / 100;

function num(v) {                                         // float(v) that throws on junk
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  throw new TypeError("not a number");
}
function str(v) {                                          // str(d["text"]): the key must exist
  if (v === undefined) throw new TypeError("missing");
  return String(v);
}
function color(v) {
  const s = String(v);
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw new TypeError("bad colour");
  return s.toLowerCase();
}

// ---------------------------------------------------------------- colours
export function parseHex(text) {
  let s = String(text ?? "").trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (!s || !/^[0-9a-fA-F]+$/.test(s)) return null;
  if (s.length === 3) s = [...s].map((c) => c + c).join("");
  if (s.length !== 6) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
export function toHex(r, g, b) {
  return "#" + [r, g, b].map((v) => clamp(pyRound(v), 0, 255).toString(16).padStart(2, "0")).join("");
}
export function itemAlpha(d) {
  const a = d.alpha;
  if (a === undefined || a === null) return LEGACY_ALPHA[d.t] ?? 255;
  return clamp(Math.trunc(a), 0, 255);
}
export function itemBright(d) { return clamp(Math.trunc(d.bright || 0), -100, 100); }
export function adjustBrightness(rgb, bright) {
  if (bright > 0) { const f = bright / 100; return rgb.map((c) => pyRound(c + (255 - c) * f)); }
  if (bright < 0) { const f = 1 + bright / 100; return rgb.map((c) => pyRound(c * f)); }
  return rgb.slice();
}
export function effectiveRgba(d) {
  const rgb = parseHex(d.color ?? "#000000") || [0, 0, 0];
  const [r, g, b] = adjustBrightness(rgb, itemBright(d));
  return [r, g, b, itemAlpha(d)];
}
export function cssColor(d) {
  const [r, g, b, a] = effectiveRgba(d);
  return `rgba(${r},${g},${b},${(a / 255).toFixed(4)})`;
}
export function noteTextColor(d) {
  const [r, g, b] = effectiveRgba(d);
  return 0.299 * r + 0.587 * g + 0.114 * b >= 140 ? "#2b2b2b" : "#f5f5f5";
}
export function sanitizeStyle(d, dflt) {
  const out = { ...dflt };
  if (!d || typeof d !== "object" || Array.isArray(d)) return out;
  const rgb = parseHex(d.color ?? "");
  if (rgb) out.color = toHex(...rgb);
  for (const [k, lo, hi] of [["width", 1, 60], ["size", 6, 144], ["alpha", 1, 255], ["bright", -100, 100]]) {
    try { out[k] = clamp(pyRound(num(d[k])), lo, hi); } catch { /* keep default */ }
  }
  return out;
}

// ------------------------------------------------------------- validation
function addExtras(d, out) {
  for (const [k, lo, hi] of [["alpha", 0, 255], ["bright", -100, 100]]) {
    if (k in d) { try { out[k] = clamp(pyRound(num(d[k])), lo, hi); } catch { /* ignore bad optional value */ } }
  }
  return out;
}
// Optional text format: dir + align (both are written together) and, for "text", a fixed box width w.
// Items without dir keep the old behaviour (direction detected per line), so old files render as before.
function addFmt(d, out) {
  if (TEXT_DIRS.includes(d.dir)) {
    out.dir = d.dir;
    out.align = TEXT_ALIGNS.includes(d.align) ? d.align : (d.dir === "rtl" ? "right" : "left");
  }
  if (out.t === "text" && d.w !== undefined) { try { out.w = Math.max(20, Math.min(4000, round2(num(d.w)))); } catch { /* ignore bad optional value */ } }
  return out;
}
export function sanitizeItem(d) {
  try {
    if (!d || typeof d !== "object") return null;
    const t = d.t;
    if (t === "pen" || t === "mark") {
      if (!Array.isArray(d.pts)) return null;
      const pts = d.pts.map((p) => [num(p[0]), num(p[1])]);
      if (!pts.length) return null;
      return addExtras(d, { t, pts, color: color(d.color), w: Math.max(0.1, num(d.w)) });
    }
    if (t === "line" || t === "arrow" || t === "rect" || t === "ellipse") {
      return addExtras(d, { t, x1: num(d.x1), y1: num(d.y1), x2: num(d.x2), y2: num(d.y2),
        color: color(d.color), w: Math.max(0.1, num(d.w)) });
    }
    if (t === "hl") {
      return addExtras(d, { t, x1: num(d.x1), y1: num(d.y1), x2: num(d.x2), y2: num(d.y2), color: color(d.color) });
    }
    if (t === "text") {
      return addFmt(d, addExtras(d, { t, x: num(d.x), y: num(d.y), text: str(d.text), color: color(d.color),
        size: Math.min(400, Math.max(4, num(d.size))) }));
    }
    if (t === "image") {
      if (typeof d.data !== "string") return null;
      const head = atob(d.data.slice(0, 12));                  // PNG signature check
      if (!head.startsWith("\x89PNG\r\n\x1a\n")) return null;
      return addExtras(d, { t, x1: num(d.x1), y1: num(d.y1), x2: num(d.x2), y2: num(d.y2), data: d.data });
    }
    if (t === "note") {
      return addFmt(d, addExtras(d, { t, x: num(d.x), y: num(d.y), w: Math.max(40, num(d.w)), h: Math.max(30, num(d.h)),
        text: str(d.text), color: color(d.color), size: Math.min(400, Math.max(4, num(d.size))) }));
    }
  } catch { return null; }
  return null;
}

// ---------------------------------------------------------------- geometry
export function distPointSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function box(d) {
  return [Math.min(d.x1, d.x2), Math.min(d.y1, d.y2), Math.max(d.x1, d.x2), Math.max(d.y1, d.y2)];
}
export function hitTest(d, x, y, tol) {
  const t = d.t;
  if (t === "pen" || t === "mark") {
    const r = d.w / 2 + tol, pts = d.pts;
    if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= r;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (distPointSegment(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) <= r) return true;
    }
    return false;
  }
  if (t === "line" || t === "arrow") return distPointSegment(x, y, d.x1, d.y1, d.x2, d.y2) <= d.w / 2 + tol;
  if (t === "rect") {
    const [x0, y0, x1, y1] = box(d);
    const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - y, 0, y - y1);
    const dist = (dx || dy) ? Math.hypot(dx, dy) : Math.min(x - x0, x1 - x, y - y0, y1 - y);
    return dist <= d.w / 2 + tol;
  }
  if (t === "ellipse") {
    const [x0, y0, x1, y1] = box(d);
    const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    if (rx < 0.5 || ry < 0.5) return distPointSegment(x, y, x0, y0, x1, y1) <= d.w / 2 + tol;
    const v = Math.hypot((x - (x0 + x1) / 2) / rx, (y - (y0 + y1) / 2) / ry);
    return Math.abs(v - 1) * Math.min(rx, ry) <= d.w / 2 + tol;
  }
  if (t === "hl" || t === "image") {
    const [x0, y0, x1, y1] = box(d);
    return x0 - tol <= x && x <= x1 + tol && y0 - tol <= y && y <= y1 + tol;
  }
  if (t === "note") {
    return d.x - tol <= x && x <= d.x + d.w + tol && d.y - tol <= y && y <= d.y + d.h + tol;
  }
  return false;                                              // text: measured by the renderer
}
export function translate(d, dx, dy) {
  const n = { ...d }, t = d.t;
  if (t === "pen" || t === "mark") n.pts = d.pts.map(([x, y]) => [round2(x + dx), round2(y + dy)]);
  else if (t === "text" || t === "note") { n.x = round2(d.x + dx); n.y = round2(d.y + dy); }
  else { n.x1 = round2(d.x1 + dx); n.y1 = round2(d.y1 + dy); n.x2 = round2(d.x2 + dx); n.y2 = round2(d.y2 + dy); }
  return n;
}

// ---------------------------------------------------------- resize handles
export function halfWidth(d) {
  return ["pen", "mark", "line", "arrow", "rect", "ellipse"].includes(d.t) ? d.w / 2 : 0;
}
export function geomBox(d, textBox = null) {
  const t = d.t;
  if (t === "pen" || t === "mark") {
    const xs = d.pts.map((p) => p[0]), ys = d.pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (t === "note") return [d.x, d.y, d.x + d.w, d.y + d.h];
  if (t === "text") return textBox.slice();
  return box(d);
}
export function bbox(d, textBox = null) {                    // geometry box including stroke width
  const h = halfWidth(d), g = geomBox(d, textBox);
  return [g[0] - h, g[1] - h, g[2] + h, g[3] + h];
}
export function handleNames(d) {
  if (d.t === "line" || d.t === "arrow") return ["p1", "p2"];
  if (d.t === "text" && d.w) return ["nw", "ne", "se", "sw", "e", "w"];     // corners scale the text, e / w change the box width
  if (d.t === "image" || d.t === "text") return ["nw", "ne", "se", "sw"];
  return ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
}
export function handlePositions(d, b, e) {
  if (d.t === "line" || d.t === "arrow") return { p1: [d.x1, d.y1], p2: [d.x2, d.y2] };
  const x0 = b[0] - e, y0 = b[1] - e, x1 = b[2] + e, y1 = b[3] + e, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const all = { nw: [x0, y0], n: [mx, y0], ne: [x1, y0], e: [x1, my], se: [x1, y1], s: [mx, y1], sw: [x0, y1], w: [x0, my] };
  const out = {};
  for (const k of handleNames(d)) out[k] = all[k];
  return out;
}
export function resizeItem(d, handle, px, py, textBox = null, e = 0, keepAspect = false) {
  const t = d.t, n = { ...d };
  if (t === "line" || t === "arrow") {
    if (handle === "p1") { n.x1 = round2(px); n.y1 = round2(py); } else { n.x2 = round2(px); n.y2 = round2(py); }
    return n;
  }
  const [ox0, oy0, ox1, oy1] = geomBox(d, textBox);
  let x0 = ox0, y0 = oy0, x1 = ox1, y1 = oy1;
  if (handle.includes("w")) x0 = Math.min(px + e, ox1 - MIN_SIZE);
  if (handle.includes("e")) x1 = Math.max(px - e, ox0 + MIN_SIZE);
  if (handle.includes("n")) y0 = Math.min(py + e, oy1 - MIN_SIZE);
  if (handle.includes("s")) y1 = Math.max(py - e, oy0 + MIN_SIZE);
  const ow = ox1 - ox0, oh = oy1 - oy0;
  let scale = null;
  if ((t === "image" || t === "text" || keepAspect) && handle.length === 2 && ow > 1e-6 && oh > 1e-6) {
    scale = Math.max((x1 - x0) / ow, (y1 - y0) / oh);
    if (t === "text") scale = Math.max(scale, 0.2);
    const nw = ow * scale, nh = oh * scale;
    if (handle.includes("w")) { x0 = ox1 - nw; x1 = ox1; } else { x0 = ox0; x1 = ox0 + nw; }
    if (handle.includes("n")) { y0 = oy1 - nh; y1 = oy1; } else { y0 = oy0; y1 = oy0 + nh; }
  }
  if (t === "rect" || t === "ellipse" || t === "hl" || t === "image") {
    n.x1 = round2(x0); n.y1 = round2(y0); n.x2 = round2(x1); n.y2 = round2(y1);
  } else if (t === "note") {
    n.x = round2(x0); n.y = round2(y0); n.w = round2(Math.max(60, x1 - x0)); n.h = round2(Math.max(40, y1 - y0));
  } else if (t === "pen" || t === "mark") {
    const sx = ow > 1e-6 ? (x1 - x0) / ow : 1, sy = oh > 1e-6 ? (y1 - y0) / oh : 1;
    n.pts = d.pts.map(([x, y]) => [
      round2(ow > 1e-6 ? x0 + (x - ox0) * sx : x + (x0 - ox0)),
      round2(oh > 1e-6 ? y0 + (y - oy0) * sy : y + (y0 - oy0))]);
  } else if (t === "text") {
    const s = scale ?? 1.0;
    n.size = Math.round(Math.min(400, Math.max(4, d.size * s)) * 10) / 10;
    n.x = round2(x0); n.y = round2(y0);
    if (d.w) n.w = round2(Math.max(20, scale != null ? d.w * s : x1 - x0));
  }
  return n;
}

// ----------------------------------------------------------------- history
export class History {
  constructor(limit = 200) { this.limit = limit; this.undo = []; this.redo = []; }
  clear() { this.undo.length = 0; this.redo.length = 0; }
  push(state, idx) {
    this.undo.push([state, idx]);
    if (this.undo.length > this.limit) this.undo.shift();
    this.redo.length = 0;
  }
  canUndo() { return this.undo.length > 0; }
  canRedo() { return this.redo.length > 0; }
  undoStep(current) { const [s, i] = this.undo.pop(); this.redo.push([current, i]); return [s, i]; }
  redoStep(current) { const [s, i] = this.redo.pop(); this.undo.push([current, i]); return [s, i]; }
}

// ------------------------------------------------------------- file formats
export function notebookToJson(pages) {
  return JSON.stringify({ format: NOTEBOOK_FORMAT, version: 1, page_size: [PAGE_W, PAGE_H],
    pages: pages.map((p) => ({ paper: p.paper, items: [...p.items] })) });
}
export function parseNotebook(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Not a valid DualNote notebook file."); }
  if (!data || typeof data !== "object" || data.format !== NOTEBOOK_FORMAT) throw new Error("Not a DualNote notebook file.");
  if (!Array.isArray(data.pages) || !data.pages.length) throw new Error("The notebook has no pages.");
  return data.pages.map((p) => {
    if (!p || typeof p !== "object") throw new Error("Corrupt page data.");
    const paper = PAPERS.includes(p.paper) ? p.paper : "blank";
    const items = (Array.isArray(p.items) ? p.items : []).map(sanitizeItem).filter(Boolean);
    return { paper, items };
  });
}
export function pdfAnnotationsToJson(pages) {
  return JSON.stringify({ format: PDF_ANNOT_FORMAT, version: 1, pages: pages.map((p) => [...p]) });
}
export function parsePdfAnnotations(raw, pageCount) {
  let data;
  try { data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { return null; }
  if (!data || data.format !== PDF_ANNOT_FORMAT || !Array.isArray(data.pages) || data.pages.length !== pageCount) return null;
  const out = [];
  for (const p of data.pages) {
    if (!Array.isArray(p)) return null;
    out.push(p.map(sanitizeItem).filter(Boolean));
  }
  return out;
}

// ----------------------------------------------------------- window layout
export function sanitizeLayout(v) {
  if (Array.isArray(v) && v.length === 2 && v.every((k) => LAYOUT_KEYS.includes(k)) && v[0] !== v[1]) return [...v];
  return [...DEFAULT_LAYOUT];
}
export function hiddenByLayoutChange(oldOrder, newOrder) { return oldOrder.filter((k) => !newOrder.includes(k)); }
export function normalizeView(view, order) {
  if (["left", "both", "right"].includes(view)) return view;
  const key = { pdf: "pdf", notebook: "nb" }[view];
  if (!key || !order.includes(key)) return "both";
  return order[0] === key ? "left" : "right";
}
