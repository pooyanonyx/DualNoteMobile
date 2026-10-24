// Small UI toolkit: DOM helper, icons, toast, modal dialog, popups, colour palette,
// custom RGB/HEX colour dialog and the brush (thickness / opacity / brightness / text size) sliders.
import * as M from "./model.js";
import { FONT_STACK } from "./render.js";

export function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (k in e && k !== "list") { try { e[k] = v; } catch { e.setAttribute(k, v); } }
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

const P = (d) => `<path d="${d}"/>`;
const ICONS = {
  select: P("M6 3l0 15 4-4 3 6 2.4-1.1-3-6 5.6-.4z"),
  pen: P("M4 20l1-4L16 5l3 3L8 19z") + P("M14 7l3 3"),
  mark: P("M4 21h9") + P("M8 17l8-8 3 3-8 8H8z") + P("M14 11l3 3"),
  hltext: P("M5 19h14") + P("M8 15l4-10 4 10") + P("M9.4 11.5h5.2"),
  eraser: P("M4 15l8-9 8 8-5 5H9z") + P("M9 20h11") + P("M8 11l7 7"),
  text: P("M5 6h14") + P("M12 6v13") + P("M9 19h6"),
  note: P("M5 4h14v11l-5 5H5z") + P("M14 20v-5h5"),
  line: P("M5 19L19 5"),
  arrow: P("M5 19L19 5") + P("M10 5h9v9"),
  rect: '<rect x="4" y="6" width="16" height="12"/>',
  shapes: '<rect x="3.5" y="11" width="9" height="9" rx="1"/>' + '<circle cx="16.5" cy="8" r="4.5"/>' + P("M5 8l3-5 3 5z"),
  triangle: P("M12 4l9 16H3z"), diamond: P("M12 3l9 9-9 9-9-9z"), pentagon: P("M12 3l8.5 6.2-3.2 10.3H6.7L3.5 9.2z"),
  hexagon: P("M3 12l4.5-8h9L21 12l-4.5 8h-9z"), star: P("M12 3l2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.2 6.4 20.3l1.2-6.3L3 9.6l6.3-.8z"),
  node: '<rect x="3" y="7" width="18" height="10" rx="4"/>' + P("M8 12h8"),
  link: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="7" r="3"/>' + P("M8.2 14.8l7.6-5.6"),
  sun: '<circle cx="12" cy="12" r="4"/>' + P("M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"),
  moon: P("M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"),
  dots: [6, 12, 18].flatMap((y) => [6, 12, 18].map((x) => `<circle cx="${x}" cy="${y}" r="1.3" fill="currentColor" stroke="none"/>`)).join(""),
  child: '<rect x="2.5" y="9" width="8" height="6" rx="2"/>' + P("M10.5 12h4") + P("M17.5 8.5v7M14 12h7"),
  sibling: '<rect x="8" y="2.5" width="8" height="6" rx="2"/>' + P("M12 8.5v4") + P("M12 14.5v6.5M8.7 17.7h6.6"),
  branchdel: '<rect x="2.5" y="9" width="7" height="6" rx="2"/>' + P("M9.5 12h3M12.5 7v10") + P("M15.5 8.5l5 7M20.5 8.5l-5 7"),
  curve: P("M4 18C4 8 20 16 20 6"),
  elbow: P("M4 18h8V6h8"),
  tools: P("M4 7h8M16 7h4M4 17h3M11 17h9") + '<circle cx="14" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  fill: P("M5 5h14v14H5z") + P("M5 13l8-8") + P("M5 19L19 5") + P("M11 19l8-8"),
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
  pan: P("M8 13V6.5a1.5 1.5 0 013 0V11") + P("M11 11V4.5a1.5 1.5 0 013 0V11") + P("M14 11V6.5a1.5 1.5 0 013 0V14c0 4-2 7-6 7s-5-2-6.5-4.5L3 13.5a1.5 1.5 0 012.4-1.6L8 14"),
  undo: P("M9 7L4 12l5 5") + P("M4 12h10a6 6 0 010 12"),
  redo: P("M15 7l5 5-5 5") + P("M20 12H10a6 6 0 000 12"),
  paste: P("M9 4h6v3H9z") + P("M7 5H5v16h14V5h-2"),
  image: '<rect x="3" y="5" width="18" height="14" rx="1"/>' + P("M3 16l5-5 4 4 3-3 6 6") + '<circle cx="15.5" cy="9" r="1.2"/>',
  open: P("M3 7h6l2 2h10v10H3z"),
  save: P("M5 4h12l3 3v13H5z") + P("M8 4v5h7V4") + P("M8 20v-6h8v6"),
  plus: P("M12 5v14M5 12h14"),
  minus: P("M5 12h14"),
  trash: P("M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"),
  prev: P("M15 5l-7 7 7 7"),
  next: P("M9 5l7 7-7 7"),
  fit: P("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"),
  menu: P("M4 7h16M4 12h16M4 17h16"),
  swap: P("M4 8h14l-3-3M20 16H6l3 3"),
  layout: '<rect x="3" y="5" width="8" height="14"/><rect x="13" y="5" width="8" height="14"/>',
  pdf: P("M6 3h8l4 4v14H6z") + P("M14 3v4h4"),
  notebook: P("M6 3h12v18H6z") + P("M9 3v18") + P("M12 8h4M12 12h4"),
  chevdown: P("M6 9l6 6 6-6"),
  close: P("M6 6l12 12M18 6L6 18"),
  ltr: P("M12.5 3H9a3.5 3.5 0 000 7h3.5M12.5 3v12M16.5 3v12") + P("M4 19h14M15 16l3 3-3 3"),
  rtl: P("M11.5 3H15a3.5 3.5 0 010 7h-3.5M11.5 3v12M7.5 3v12") + P("M20 19H6M9 16l-3 3 3 3"),
  alignleft: P("M4 6h16M4 10h10M4 14h16M4 18h10"),
  aligncenter: P("M4 6h16M7 10h10M4 14h16M7 18h10"),
  alignright: P("M4 6h16M10 10h10M4 14h16M10 18h10"),
  ruled: P("M4 7h16M4 12h16M4 17h16") + P("M7 14V8l-2 2M7 8l2 2"),
  brush: P("M18 3l3 3-9 9-3-3z") + P("M9 12c-3 0-4 2-4 4s-1 3-2 4c4 1 8-1 8-5"),
};
export function icon(name, cls = "") {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "ic " + cls);
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.9"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name] || "";
  return s;
}

// ------------------------------------------------------------------- toast
export function toast(msg, ms = 2600) {
  let box = document.getElementById("toasts");
  if (!box) { box = el("div", { id: "toasts" }); document.body.append(box); }
  const t = el("div", { class: "toast", role: "status" }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, ms);
}

// ------------------------------------------------------------------ dialog
/** Modal dialog. buttons: [{label, value, primary, danger}]. Resolves with the clicked value (null on Esc/backdrop). */
export function dialog({ title, content, buttons = [{ label: "OK", value: true, primary: true }] }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const done = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); prevFocus?.focus?.(); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
    const body = typeof content === "string" ? el("p", {}, content) : content;
    const btns = buttons.map((b) => el("button", { class: "btn " + (b.primary ? "primary " : "") + (b.danger ? "danger" : ""), type: "button",
      onclick: () => done(b.value) }, b.label));
    const box = el("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
      title ? el("h2", {}, title) : null, el("div", { class: "dbody" }, body), el("div", { class: "dbtns" }, btns));
    const back = el("div", { class: "backdrop", onpointerdown: (e) => { if (e.target === back) done(null); } }, box);
    document.body.append(back);
    document.addEventListener("keydown", onKey, true);
    (btns.find((b) => b.classList.contains("primary")) || btns[0])?.focus();
  });
}

// ------------------------------------------------------------------- popup
let openPopup = null;
export function closePopup() { openPopup?.close(); }
/** Show `content` in a floating card next to `anchor`. */
export function popup(anchor, content, { onClose } = {}) {
  if (openPopup && openPopup.anchor === anchor) { closePopup(); return null; }   // pressing the same button again closes its popup
  closePopup();
  const card = el("div", { class: "popup" }, content);
  document.body.append(card);
  const place = () => {
    const r = anchor.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = Math.min(Math.max(8, r.left), vw - w - 8), y = r.bottom + 6;
    if (y + h > vh - 8) y = Math.max(8, r.top - h - 6);
    card.style.left = x + "px"; card.style.top = y + "px";
    card.style.maxHeight = (vh - 16) + "px";
  };
  place();
  const onDown = (e) => { if (!card.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } };   // Escape closes the menu only (the app must not also deselect)
  setTimeout(() => document.addEventListener("pointerdown", onDown, true), 0);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", close, { once: true });
  function close() {
    if (openPopup !== handle) return;
    openPopup = null; card.remove();
    document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey, true);
    onClose?.();
  }
  const handle = { close, place, card, anchor };
  openPopup = handle;
  return handle;
}

// ----------------------------------------------------------------- palette
export const PALETTE_ROWS = [
  ["#000000", "#1a1a1a", "#424242", "#757575", "#9e9e9e", "#bdbdbd", "#e0e0e0", "#ffffff"],
  ["#d32f2f", "#f57c00", "#fbc02d", "#388e3c", "#00796b", "#1976d2", "#303f9f", "#7b1fa2"],
  ["#ff1744", "#ff9100", "#ffea00", "#00e676", "#1de9b6", "#00b0ff", "#651fff", "#f50057"],
  ["#fff176", "#ffcc80", "#a5d6a7", "#80deea", "#90caf9", "#ce93d8", "#f48fb1", "#ffab91"],
  ["#5d4037", "#8d6e63", "#a1887f", "#263238", "#546e7a", "#b0bec5", "#c5e1a5", "#ffe082"],
];
export function swatch(hex, onpick, title) {
  return el("button", { class: "sw", type: "button", title: title || hex.toUpperCase(), "aria-label": hex,
    style: { background: hex }, onclick: () => onpick(hex) });
}
export function paletteContent({ recent, onPick, onCustom }) {
  const grid = el("div", { class: "palette" }, PALETTE_ROWS.flat().map((h) => swatch(h, onPick)));
  const rec = el("div", { class: "palette recent" }, recent.length ? recent.map((h) => swatch(h, onPick)) : el("span", { class: "muted" }, "—"));
  return el("div", { class: "pcol" }, grid, el("div", { class: "plabel" }, "Recent"), rec,
    el("button", { class: "btn wide", type: "button", onclick: onCustom }, "Custom color… (RGB / HEX)"));
}

/** Custom colour dialog with RGB sliders/numbers and HEX field. Resolves '#rrggbb' or null. */
export function customColorDialog(initial = "#000000") {
  let rgb = M.parseHex(initial) || [0, 0, 0];
  const preview = el("div", { class: "cprev" });
  const sliders = [], nums = [];
  const hex = el("input", { type: "text", class: "hex", maxLength: 7, inputMode: "text", autocomplete: "off", spellcheck: false, "aria-label": "HEX" });
  const refresh = (updateHex = true) => {
    for (let i = 0; i < 3; i++) { sliders[i].value = rgb[i]; nums[i].value = rgb[i]; }
    if (updateHex) hex.value = M.toHex(...rgb).toUpperCase();
    preview.style.background = M.toHex(...rgb);
  };
  const rows = ["R", "G", "B"].map((name, i) => {
    const s = el("input", { type: "range", min: 0, max: 255, step: 1, "aria-label": name, oninput: () => { rgb[i] = +s.value; refresh(); } });
    const n = el("input", { type: "number", min: 0, max: 255, inputMode: "numeric", "aria-label": name + " value",
      oninput: () => { rgb[i] = Math.max(0, Math.min(255, Math.round(+n.value || 0))); refresh(); } });
    sliders.push(s); nums.push(n);
    return el("div", { class: "crow" }, el("span", {}, name), s, n);
  });
  hex.addEventListener("input", () => {
    const t = hex.value.replace(/^#/, "");
    if ([3, 6].includes(t.length)) { const p = M.parseHex(hex.value); if (p) { rgb = p; refresh(false); } }
  });
  hex.addEventListener("change", () => refresh(true));
  refresh();
  const content = el("div", { class: "cdlg" }, preview, rows, el("div", { class: "crow" }, el("span", {}, "HEX"), hex));
  return dialog({ title: "Custom color", content, buttons: [{ label: "Cancel", value: null }, { label: "OK", value: "ok", primary: true }] })
    .then((v) => (v === "ok" ? M.toHex(...rgb) : null));
}

// ------------------------------------------------------------ brush sliders
const BRUSH = [["width", "Thickness", 1, 60, (v) => `${v} pt`], ["alpha", "Opacity", 5, 100, (v) => `${v}%`],
  ["bright", "Brightness", -100, 100, (v) => (v > 0 ? "+" : "") + v], ["size", "Text size", 6, 144, (v) => `${v} pt`]];
const toSlider = (k, v) => (k === "alpha" ? Math.max(5, Math.round(v * 100 / 255)) : v);
const toStyle = (k, v) => (k === "alpha" ? Math.round(v * 255 / 100) : v);

/** Sliders for thickness/opacity/brightness/text size with live preview.
 *  onInput(key, value) fires while dragging; onCommit(key, value) when released/changed. */
export function brushContent({ getStyle, onInput, onCommit, widthEnabled = true, eraser = false }) {
  const rows = {}, prev = el("canvas", { class: "bprev", width: 440, height: 116 });
  const drawPreview = () => {
    const st = getStyle(), ctx = prev.getContext("2d"), w = prev.width, h = prev.height;
    for (let y = 0; y < h; y += 16) for (let x = 0; x < w; x += 16) { ctx.fillStyle = ((x + y) / 16) % 2 ? "#dcdcdc" : "#fff"; ctx.fillRect(x, y, 16, 16); }
    if (eraser) {                                                  // a stroke with the part the eraser removes cut out, and the eraser's outline
      const gap = Math.min(2 * st.width, 100), cx = w / 2, cy = h / 2;
      ctx.lineCap = "round"; ctx.strokeStyle = "#333"; ctx.lineWidth = 8;
      ctx.beginPath(); ctx.moveTo(24, cy); ctx.lineTo(cx - gap / 2 - 4, cy); ctx.moveTo(cx + gap / 2 + 4, cy); ctx.lineTo(w - 24, cy); ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = "#1976d2"; ctx.beginPath(); ctx.arc(cx, cy, gap / 2, 0, Math.PI * 2); ctx.stroke();
      return;
    }
    const col = M.cssColor({ color: st.color, alpha: st.alpha, bright: st.bright });
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = col; ctx.lineWidth = Math.min(2 * st.width, 56);
    ctx.beginPath(); ctx.moveTo(28, h * 0.7); ctx.bezierCurveTo(w * 0.25, h * 0.0, w * 0.45, h * 1.15, w * 0.62, h * 0.35); ctx.stroke();
    ctx.fillStyle = col; ctx.font = `${Math.min(Math.max(2 * st.size, 16), 72)}px ${FONT_STACK}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Aa", w * 0.86, h / 2);
  };
  const box = el("div", { class: "brush" });
  for (const [key, label0, lo0, hi0, fmt] of BRUSH) {
    if (eraser && key !== "width") continue;                       // the eraser only has a size
    const label = eraser ? "Eraser size" : label0, lo = eraser ? 4 : lo0, hi = eraser ? 120 : hi0;
    const val = el("span", { class: "bval" });
    const sl = el("input", { type: "range", min: lo, max: hi, step: 1, "aria-label": label });
    sl.addEventListener("input", () => { val.textContent = fmt(+sl.value); onInput?.(key, toStyle(key, +sl.value)); drawPreview(); });
    sl.addEventListener("change", () => onCommit?.(key, toStyle(key, +sl.value)));
    rows[key] = { sl, val, fmt };
    box.append(el("label", { class: "brow" }, el("span", { class: "blab" }, label), sl, val));
  }
  box.append(prev);
  const update = (st = getStyle(), widthOn = widthEnabled) => {
    for (const [key] of BRUSH) { const r = rows[key]; if (!r) continue; r.sl.value = toSlider(key, st[key]); r.val.textContent = r.fmt(+r.sl.value); }
    rows.width.sl.disabled = !widthOn;
    drawPreview();
  };
  update();
  box.update = update;
  return box;
}
