// NoteFlow data model (pure JavaScript, no DOM) - a port of model.py so that files made
// by the Windows app and by this app are interchangeable.
//
// Every drawing is a small JSON object ("item") in page coordinates (PDF points):
//   pen / mark   {t, pts:[[x,y],...], color:"#rrggbb", w}
//   line / arrow {t, x1,y1,x2,y2, color, w}        rect / ellipse: same fields (+ optional fill: "#rrggbb" = filled interior)
//   shape {t, kind, x1,y1,x2,y2, color, w, fill?}   other closed shapes inside a box: triangle, diamond, pentagon, hexagon, star
//   hl           {t:"hl", x1,y1,x2,y2, color}      (text highlight box)
//   image        {t:"image", x1,y1,x2,y2, data: base64 PNG}
//   note         {t:"note", x,y,w,h, text, color (paper), size}
//   text         {t:"text", x,y, text, color, size}
// Any item may also carry alpha (0..255) and bright (-100..100).
// Items are never modified in place: an edit creates a new object (cheap undo snapshots).

export const PAGE_W = 595.0, PAGE_H = 842.0;             // notebook page = A4 in points
export const PAPERS = ["blank", "lined", "grid"];
export const NOTE_W = 190.0, NOTE_H = 140.0, NOTE_HEADER = 16.0;
// File-format identifiers keep their original "DualNote-..." names on purpose: existing files, annotated PDFs and the Windows app check them.
export const NOTEBOOK_FORMAT = "DualNote-notebook";
export const PDF_ANNOT_FORMAT = "DualNote-pdf-annotations";
export const EMBED_SRC = "dualnote_source.pdf";
export const EMBED_JSON = "dualnote_annotations.json";
export const LEGACY_ALPHA = { mark: 110, hl: 100 };
export const MIN_SIZE = 4.0;
export const TEXT_DIRS = ["ltr", "rtl"];                    // explicit text direction of a text / note item
export const TEXT_ALIGNS = ["left", "center", "right"];     // explicit alignment (separate from direction)
export const TEXT_BOX_W = 300.0;                              // default width of a new text box

// ------------------------------------------------------------------ shapes
// Every shape is dragged out as a box (x1,y1)-(x2,y2). line / arrow / rect / ellipse keep their own item types (old files);
// the other closed shapes are t:"shape" with a kind, drawn as a polygon scaled into the box.
const normPoly = (pts) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return pts.map(([x, y]) => [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)]);
};
const regularPoly = (n, rot) => normPoly(Array.from({ length: n }, (_, i) => [Math.cos(rot + 2 * Math.PI * i / n), Math.sin(rot + 2 * Math.PI * i / n)]));
const starPoly = (n, ratio) => normPoly(Array.from({ length: 2 * n }, (_, i) => { const r = i % 2 ? ratio : 1, a = -Math.PI / 2 + Math.PI * i / n; return [r * Math.cos(a), r * Math.sin(a)]; }));
export const SHAPE_POLYS = {
  triangle: [[0.5, 0], [1, 1], [0, 1]], diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
  pentagon: regularPoly(5, -Math.PI / 2), hexagon: regularPoly(6, 0), star: starPoly(5, 0.382),
};
export const SHAPE_KINDS = [
  { id: "line", label: "Line", t: "line", closed: false }, { id: "arrow", label: "Arrow", t: "arrow", closed: false },
  { id: "rect", label: "Rectangle", t: "rect", closed: true }, { id: "ellipse", label: "Ellipse", t: "ellipse", closed: true },
  { id: "triangle", label: "Triangle", t: "shape", closed: true }, { id: "diamond", label: "Diamond", t: "shape", closed: true },
  { id: "pentagon", label: "Pentagon", t: "shape", closed: true }, { id: "hexagon", label: "Hexagon", t: "shape", closed: true },
  { id: "star", label: "Star", t: "shape", closed: true },
];
export const shapeKindInfo = (id) => SHAPE_KINDS.find((k) => k.id === id) || SHAPE_KINDS[2];
export const isClosedShape = (d) => d.t === "rect" || d.t === "ellipse" || d.t === "shape" || d.t === "node";   // can have a filled interior
// ------------------------------------------------------------------ board + mind map
// A Board is ONE big page of ordinary items (pen, text, shapes, images ...) plus mind-map items:
//   node {t:"node", id, kind: round|ellipse|rect, x1,y1,x2,y2, text, color, w, size, fill?, dir?, align?}
//   conn {t:"conn", from: nodeId, to: nodeId, style: curve|line|elbow, arrow: bool, color, w, label?}
// A connector stores the ids of its two nodes, not coordinates: its path follows the nodes when they move.
export const BOARD_FORMAT = "DualNote-board", BOARD_W = 4000.0, BOARD_H = 3000.0;
export const BOARD_BGS = ["white", "black"];                  // page.paper of a board; page.grid = dotted grid on/off
export const NODE_KINDS = ["round", "ellipse", "rect"], CONN_STYLES = ["curve", "line", "elbow"];
export const NODE_PAD = 10, NODE_MIN_W = 90, NODE_MIN_H = 44, NODE_MAX_W = 260, NODE_GAP_X = 90, NODE_GAP_Y = 24;
export const newId = () => "n" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
export const nodeIndex = (items) => { const m = new Map(); for (const d of items) if (d.t === "node" && d.id) m.set(d.id, d); return m; };
export const hasConns = (items) => items.some((d) => d.t === "conn");
/** Drop connectors whose node no longer exists (after a node was deleted / erased). */
export function pruneOrphans(items) {
  if (!hasConns(items)) return items;
  const ids = nodeIndex(items), keep = items.filter((d) => d.t !== "conn" || (ids.has(d.from) && ids.has(d.to)));
  return keep.length === items.length ? items : keep;
}
const nodeCenter = (n) => [(n.x1 + n.x2) / 2, (n.y1 + n.y2) / 2];
function anchorOn(n, tx, ty) {                                // where the ray from the node's centre towards (tx,ty) leaves the node
  const [cx, cy] = nodeCenter(n), hw = Math.max(1, Math.abs(n.x2 - n.x1) / 2), hh = Math.max(1, Math.abs(n.y2 - n.y1) / 2), dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const k = n.kind === "ellipse" ? 1 / Math.hypot(dx / hw, dy / hh) : 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return [cx + dx * k, cy + dy * k];
}
/** Path of a connector between its nodes (nodes = nodeIndex(items)). d.toPt = a free end point (while dragging a new link). */
export function connGeometry(d, nodes) {
  const A = nodes.get(d.from), B = d.to ? nodes.get(d.to) : null;
  if (!A || (!B && !d.toPt)) return null;
  const ca = nodeCenter(A), cb = B ? nodeCenter(B) : d.toPt, dx = cb[0] - ca[0], dy = cb[1] - ca[1];
  let pts;
  if (d.style === "line") {
    pts = [anchorOn(A, cb[0], cb[1]), B ? anchorOn(B, ca[0], ca[1]) : cb];
  } else {
    const horiz = Math.abs(dx) >= Math.abs(dy), sg = (horiz ? dx : dy) >= 0 ? 1 : -1;
    const s = horiz ? [sg > 0 ? Math.max(A.x1, A.x2) : Math.min(A.x1, A.x2), ca[1]] : [ca[0], sg > 0 ? Math.max(A.y1, A.y2) : Math.min(A.y1, A.y2)];
    const e = B ? (horiz ? [sg > 0 ? Math.min(B.x1, B.x2) : Math.max(B.x1, B.x2), cb[1]] : [cb[0], sg > 0 ? Math.min(B.y1, B.y2) : Math.max(B.y1, B.y2)]) : cb;
    if (d.style === "elbow") {
      pts = horiz ? [s, [(s[0] + e[0]) / 2, s[1]], [(s[0] + e[0]) / 2, e[1]], e] : [s, [s[0], (s[1] + e[1]) / 2], [e[0], (s[1] + e[1]) / 2], e];
    } else {                                                   // curve: cubic Bezier leaving / entering the nodes straight
      const k = Math.max(40, (horiz ? Math.abs(e[0] - s[0]) : Math.abs(e[1] - s[1])) / 2);
      const c1 = horiz ? [s[0] + sg * k, s[1]] : [s[0], s[1] + sg * k], c2 = horiz ? [e[0] - sg * k, e[1]] : [e[0], e[1] - sg * k];
      pts = [];
      for (let i = 0; i <= 28; i++) {
        const u = i / 28, v = 1 - u, a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, f = u * u * u;
        pts.push([a * s[0] + b * c1[0] + c * c2[0] + f * e[0], a * s[1] + b * c1[1] + c * c2[1] + f * e[1]]);
      }
    }
  }
  const n = pts.length, [px, py] = pts[n - 2], [qx, qy] = pts[n - 1];
  let len = 0; const seg = [];
  for (let i = 0; i + 1 < n; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); seg.push(l); len += l; }
  let half = len / 2, mid = pts[0];
  for (let i = 0; i < seg.length; i++) { if (half <= seg[i] || i === seg.length - 1) { const f = seg[i] ? Math.min(1, half / seg[i]) : 0; mid = [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]; break; } half -= seg[i]; }
  return { pts, mid, end: [qx, qy], angle: Math.atan2(qy - py, qx - px) };
}
export function connBounds(d, nodes) {
  const g = connGeometry(d, nodes);
  if (!g) return [0, 0, 0, 0];
  const xs = g.pts.map((p) => p[0]), ys = g.pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
export function boardToJson(page) {
  return JSON.stringify({ format: BOARD_FORMAT, version: 1, size: [BOARD_W, BOARD_H], background: page.paper, grid: !!page.grid, items: [...page.items] });
}
/** -> {paper, grid, items}; throws Error with a readable message for foreign / damaged data. */
export function parseBoard(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Not a valid NoteFlow board file."); }
  if (!data || typeof data !== "object" || data.format !== BOARD_FORMAT) throw new Error("Not a NoteFlow board file.");
  const items = pruneOrphans((Array.isArray(data.items) ? data.items : []).map(sanitizeItem).filter(Boolean));
  return { paper: BOARD_BGS.includes(data.background) ? data.background : "white", grid: !!data.grid, items };
}
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export const LAYOUT_KEYS = ["pdf", "pdf2", "nb", "nb2", "board", "board2"];
export const DEFAULT_LAYOUT = ["pdf", "nb"];
// Workspace type = which panels the workspace is made of, left to right. It is stored in the workspace file (manifest.workspace_type).
export const WORKSPACE_TYPES = { pdf: ["pdf"], notebook: ["nb"], board: ["board"], "pdf+notebook": ["pdf", "nb"], "notebook+pdf": ["nb", "pdf"],
  "pdf+board": ["pdf", "board"], "notebook+board": ["nb", "board"], "pdf+notebook+board": ["pdf", "nb", "board"] };   // anything else is saved as "custom" + the explicit panel list
export const MAX_PANELS = 3;
export const workspaceTypeOf = (order) => Object.keys(WORKSPACE_TYPES).find((t) => WORKSPACE_TYPES[t].join() === order.join()) || null;
export const layoutOfType = (t) => (typeof t === "string" && Object.hasOwn(WORKSPACE_TYPES, t) ? [...WORKSPACE_TYPES[t]] : null);

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
function addFmt(d, out) {          // (hoisted: also used by node items)
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
    if (t === "node") {
      const out = { t, id: String(d.id || newId()).slice(0, 40), kind: NODE_KINDS.includes(d.kind) ? d.kind : "round",
        x1: num(d.x1), y1: num(d.y1), x2: num(d.x2), y2: num(d.y2), text: str(d.text), color: color(d.color),
        w: Math.max(0.1, num(d.w)), size: Math.min(400, Math.max(4, num(d.size))) };
      if (typeof d.fill === "string") { try { out.fill = color(d.fill); } catch { /* ignore bad optional value */ } }
      return addFmt(d, addExtras(d, out));
    }
    if (t === "conn") {
      if (typeof d.from !== "string" || typeof d.to !== "string" || !d.from || !d.to) return null;
      const out = { t, from: d.from.slice(0, 40), to: d.to.slice(0, 40), style: CONN_STYLES.includes(d.style) ? d.style : "curve", arrow: d.arrow !== false,
        color: color(d.color), w: Math.max(0.1, num(d.w)) };
      if (typeof d.label === "string" && d.label) out.label = d.label.slice(0, 500);
      return addExtras(d, out);
    }
    if (t === "line" || t === "arrow" || t === "rect" || t === "ellipse" || t === "shape") {
      const out = { t, x1: num(d.x1), y1: num(d.y1), x2: num(d.x2), y2: num(d.y2), color: color(d.color), w: Math.max(0.1, num(d.w)) };
      if (t === "shape") out.kind = SHAPE_POLYS[d.kind] ? d.kind : "triangle";
      if (t !== "line" && t !== "arrow" && typeof d.fill === "string") { try { out.fill = color(d.fill); } catch { /* ignore bad optional value */ } }
      return addExtras(d, out);
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
export function hitTest(d, x, y, tol, nodes = null) {
  const t = d.t;
  if (t === "node") { const [x0, y0, x1, y1] = box(d); return x0 - tol <= x && x <= x1 + tol && y0 - tol <= y && y <= y1 + tol; }
  if (t === "conn") {
    const g = nodes && connGeometry(d, nodes);
    if (!g) return false;
    for (let i = 0; i + 1 < g.pts.length; i++) if (distPointSegment(x, y, g.pts[i][0], g.pts[i][1], g.pts[i + 1][0], g.pts[i + 1][1]) <= d.w / 2 + tol) return true;
    return !!d.label && Math.abs(x - g.mid[0]) <= 4 * d.label.length + 10 && Math.abs(y - g.mid[1]) <= 12;
  }
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
    if (d.fill && x0 <= x && x <= x1 && y0 <= y && y <= y1) return true;           // a filled shape is also hit inside
    const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - y, 0, y - y1);
    const dist = (dx || dy) ? Math.hypot(dx, dy) : Math.min(x - x0, x1 - x, y - y0, y1 - y);
    return dist <= d.w / 2 + tol;
  }
  if (t === "ellipse") {
    const [x0, y0, x1, y1] = box(d);
    const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    if (rx < 0.5 || ry < 0.5) return distPointSegment(x, y, x0, y0, x1, y1) <= d.w / 2 + tol;
    const v = Math.hypot((x - (x0 + x1) / 2) / rx, (y - (y0 + y1) / 2) / ry);
    if (d.fill && v <= 1) return true;
    return Math.abs(v - 1) * Math.min(rx, ry) <= d.w / 2 + tol;
  }
  if (t === "shape") {
    const pts = shapePoints(d);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (distPointSegment(x, y, a[0], a[1], b[0], b[1]) <= d.w / 2 + tol) return true;
    }
    return !!d.fill && pointInPoly(x, y, pts);
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
// ------------------------------------------------------------------ partial eraser (pen / marker strokes)
/** Part [t0,t1] (0..1) of the segment p0->p1 that lies inside the capsule = all points within r of the segment a->b (null if none). */
export function segCapsuleInterval(p0, p1, a, b, r) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], ivs = [];
  const disk = (c) => {
    const fx = p0[0] - c[0], fy = p0[1] - c[1], A = dx * dx + dy * dy, Bq = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
    if (A < 1e-12) return C <= 0 ? [0, 1] : null;
    const disc = Bq * Bq - 4 * A * C;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    return [(-Bq - s) / (2 * A), (-Bq + s) / (2 * A)];
  };
  ivs.push(disk(a));
  const ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey);
  if (L > 1e-9) {                                   // swept eraser: the two end disks + the rectangle between them (together: a convex capsule)
    ivs.push(disk(b));
    const ux = ex / L, uy = ey / L, vx = -uy, vy = ux;
    const u0 = (p0[0] - a[0]) * ux + (p0[1] - a[1]) * uy, du = dx * ux + dy * uy, v0 = (p0[0] - a[0]) * vx + (p0[1] - a[1]) * vy, dv = dx * vx + dy * vy;
    let lo = -Infinity, hi = Infinity, ok = true;
    const clip = (q0, dq, qmin, qmax) => {
      if (Math.abs(dq) < 1e-12) { if (q0 < qmin || q0 > qmax) ok = false; return; }
      let t1 = (qmin - q0) / dq, t2 = (qmax - q0) / dq;
      if (t1 > t2) [t1, t2] = [t2, t1];
      lo = Math.max(lo, t1); hi = Math.min(hi, t2);
    };
    clip(u0, du, 0, L); clip(v0, dv, -r, r);
    ivs.push(ok && lo <= hi ? [lo, hi] : null);
  }
  let lo = Infinity, hi = -Infinity;
  for (const iv of ivs) { if (!iv) continue; const l = Math.max(0, iv[0]), h = Math.min(1, iv[1]); if (l <= h) { lo = Math.min(lo, l); hi = Math.max(hi, h); } }
  return lo <= hi ? [lo, hi] : null;
}
const polyLen = (pts) => { let s = 0; for (let i = 0; i + 1 < pts.length; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return s; };
/**
 * Erase the part of a pen / marker stroke covered by an eraser of radius r moving from point a to point b.
 * Returns null when the stroke is untouched, otherwise the remaining pieces (0, 1 or more strokes with the same colour / width / alpha).
 * The stroke is a line of thickness d.w with round ends, so the cut is made at r + w/2 from the eraser: the visible stroke then
 * ends exactly at the eraser's edge.
 */
export function erasePen(d, a, b, r) {
  const rr = r + d.w / 2, pts = d.pts, n = pts.length, r2 = (v) => Math.round(v * 100) / 100;
  if (!n) return null;
  if (n === 1) return distPointSegment(pts[0][0], pts[0][1], a[0], a[1], b[0], b[1]) <= rr ? [] : null;
  const pieces = []; let cur = null, touched = false;
  for (let i = 0; i + 1 < n; i++) {
    const P = pts[i], Q = pts[i + 1], iv = segCapsuleInterval(P, Q, a, b, rr);
    if (!iv) { if (!cur) cur = [P]; cur.push(Q); continue; }
    touched = true;
    const [t0, t1] = iv, at = (t) => [r2(P[0] + (Q[0] - P[0]) * t), r2(P[1] + (Q[1] - P[1]) * t)];
    if (t0 > 1e-6) { if (!cur) cur = [P]; cur.push(at(t0)); }             // the part before the eraser
    if (cur) { pieces.push(cur); cur = null; }
    if (t1 < 1 - 1e-6) cur = [at(t1), Q];                                  // the part after the eraser continues the stroke
  }
  if (cur) pieces.push(cur);
  if (!touched) return null;
  return pieces.filter((pc) => pc.length >= 2 && polyLen(pc) >= 0.4).map((pc) => ({ ...d, pts: pc }));
}

/** Corner points of a t:"shape" item in page coordinates. */
export function shapePoints(d) {
  const [x0, y0, x1, y1] = box(d), w = x1 - x0, h = y1 - y0;
  return (SHAPE_POLYS[d.kind] || SHAPE_POLYS.triangle).map(([u, v]) => [x0 + u * w, y0 + v * h]);
}
export function translate(d, dx, dy) {
  const n = { ...d }, t = d.t;
  if (t === "conn") return n;                                // follows its nodes
  if (t === "pen" || t === "mark") n.pts = d.pts.map(([x, y]) => [round2(x + dx), round2(y + dy)]);
  else if (t === "text" || t === "note") { n.x = round2(d.x + dx); n.y = round2(d.y + dy); }
  else { n.x1 = round2(d.x1 + dx); n.y1 = round2(d.y1 + dy); n.x2 = round2(d.x2 + dx); n.y2 = round2(d.y2 + dy); }
  return n;
}

// ---------------------------------------------------------- resize handles
export function halfWidth(d) {
  return ["pen", "mark", "line", "arrow", "rect", "ellipse", "shape", "node", "conn"].includes(d.t) ? d.w / 2 : 0;
}
export function geomBox(d, textBox = null, nodes = null) {
  const t = d.t;
  if (t === "conn") return nodes ? connBounds(d, nodes) : [0, 0, 0, 0];
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
  if (d.t === "conn") return [];                             // a connector is edited through its nodes; it has no resize handles
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
  if (t === "rect" || t === "ellipse" || t === "shape" || t === "node" || t === "hl" || t === "image") {
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
  try { data = JSON.parse(text); } catch { throw new Error("Not a valid NoteFlow notebook file."); }
  if (!data || typeof data !== "object" || data.format !== NOTEBOOK_FORMAT) throw new Error("Not a NoteFlow notebook file.");
  if (!Array.isArray(data.pages) || !data.pages.length) throw new Error("The notebook has no pages.");
  return data.pages.map((p) => {
    if (!p || typeof p !== "object") throw new Error("Corrupt page data.");
    const paper = PAPERS.includes(p.paper) ? p.paper : "blank";
    const items = pruneOrphans((Array.isArray(p.items) ? p.items : []).map(sanitizeItem).filter(Boolean));
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
    out.push(pruneOrphans(p.map(sanitizeItem).filter(Boolean)));
  }
  return out;
}

// ----------------------------------------------------------- window layout
export function sanitizeLayout(v) {
  if (Array.isArray(v) && v.length >= 1 && v.length <= MAX_PANELS && v.every((k) => LAYOUT_KEYS.includes(k)) && new Set(v).size === v.length) return [...v];
  return [...DEFAULT_LAYOUT];
}
export function hiddenByLayoutChange(oldOrder, newOrder) { return oldOrder.filter((k) => !newOrder.includes(k)); }
export function normalizeView(view, order) {
  if (order.length < 2) return "both";                         // single-panel workspace: nothing to switch between
  if (["left", "both", "right"].includes(view)) return view;
  const key = { pdf: "pdf", notebook: "nb" }[view];
  if (!key || !order.includes(key)) return "both";
  return order[0] === key ? "left" : "right";
}
