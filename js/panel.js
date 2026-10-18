// One panel (PDF or notebook): canvas view with pan/zoom, all drawing tools, selection with resize
// handles, text/note editing, undo/redo, toolbars. Touch, pen and mouse all use Pointer Events.
import * as M from "./model.js";
import * as R from "./render.js";
import * as PDF from "./pdfio.js";
import { el, icon, toast, dialog, popup, closePopup, paletteContent, customColorDialog, brushContent } from "./ui.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const TOOL_INFO = {
  select: ["Select", "Select, move, resize, recolour or delete. Double-tap text/notes to edit. Drag empty space to scroll."],
  pen: ["Pen", "Freehand pen"], mark: ["Marker", "Semi-transparent highlighter marker"],
  hltext: ["Highlight", "Drag across PDF text to highlight whole words"], eraser: ["Eraser", "Drag over items to erase them"],
  text: ["Text", "Tap to add a text box"], note: ["Note", "Tap to stick a sticky note on the page"],
  shape: ["Shapes", "Pick a shape (line, arrow, rectangle, ellipse, triangle, ...) and draw it"],
  pan: ["Hand", "Drag to scroll"],
};
const PDF_TOOLS = ["select", "pen", "mark", "hltext", "eraser", "text", "note", "shape", "pan"];
const NB_TOOLS = ["select", "pen", "mark", "eraser", "text", "note", "shape", "pan"];
const GROUP_OF_TOOL = { pen: "draw", text: "draw", shape: "draw", mark: "mark", hltext: "hltext", note: "note" };
const OLD_SHAPE_TOOLS = ["line", "arrow", "rect", "ellipse"];     // separate tools of older versions / workspaces -> Shapes tool
const STYLE_TO_ITEM = { color: "color", width: "w", size: "size", alpha: "alpha", bright: "bright" };
export function defaultGroups(color = "#d32f2f") {
  return {
    draw: { color, width: 2, size: 18, alpha: 255, bright: 0 },
    mark: { color: "#fdd835", width: 14, size: 18, alpha: 110, bright: 0 },
    hltext: { color: "#fdd835", width: 14, size: 18, alpha: 100, bright: 0 },
    note: { color: "#fff59d", width: 2, size: 16, alpha: 255, bright: 0 },
  };
}
const HANDLE_R = 7;                       // drawn handle radius (screen px)
const MAX_IMAGE_SIDE = 2400;
const GAP = 12;                      // space between pages in the continuous PDF view (page units)
const RASTER_BUDGET = 40e6;          // max total pixels of cached page bitmaps (memory limit)
const RASTER_MAX = 12;               // max cached page bitmaps
const freeCanvas = (c) => { try { c.width = c.height = 0; } catch { /* ignore */ } };

export class Panel {
  constructor(app, key, kind, label) {
    this.app = app; this.key = key; this.kind = kind; this.label = label;
    this.name = null;                     // file name shown in the title
    this.pages = kind === "nb" ? [{ paper: "lined", items: [] }] : [];
    this.cur = 0; this.dirty = false; this.history = new M.History();
    this.view = { scale: 1, tx: 0, ty: 0, fit: true };
    this.cw = 300; this.ch = 300; this.dpr = window.devicePixelRatio || 1;
    this.tool = "pen";
    this.groups = defaultGroups(kind === "nb" ? "#1a1a1a" : "#d32f2f");
    this.curStyle = { ...this.groups.draw };
    this.recent = [];
    this.selected = null; this.live = null; this.preview = null; this.action = null;
    this.editing = null; this.pointers = new Map(); this.gesture = null; this.lastPen = 0; this.lastTap = null;
    this.pdf = null; this.sizes = []; this.words = null; this.wordsPage = -1; this.pageToken = 0;
    // continuous PDF view: page layout + cached page bitmaps (only pages near the screen are rendered)
    this.rasters = new Map(); this.rasterJob = null; this.rasterTimer = 0; this.badPages = new Set();
    this.sizeJobs = new Map(); this.offs = null; this.docW = 595; this.docH = 842; this.vp = 0; this.vpLock = null; this.fling = 0;
    this.fmt = { dir: "ltr", align: "left" }; this.fmtKey = "";      // text direction / alignment used for new text
    this.shapeKind = "rect"; this.fillOn = false; this.fillKey = "";  // Shapes tool: active shape + Fill switch
    if (kind === "nb") { this.layout(); this.view.ty = 14; }
    this._raf = 0; this.barsOpen = true;
    this.buildDom();
    this.setTool("pen", true);
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.stage);
    this.ui();
  }

  // ------------------------------------------------------------------ state
  get items() { return this.pages[this.cur]?.items ?? []; }
  get drawList() { return this.live ?? this.items; }
  get hasPage() { return this.kind === "nb" || !!this.pdf; }
  pageDims() { return this.kind === "nb" ? [M.PAGE_W, M.PAGE_H] : this.sizeOf(this.cur); }
  continuous() { return true; }                                      // PDF and notebook share one continuous page column
  shown() { return this.continuous() ? this.vp : this.cur; }         // page number shown in the toolbar
  defSize() { return this.sizes[0] || this.sizes.find(Boolean) || [595, 842]; }
  sizeOf(i) { return this.kind === "nb" ? [M.PAGE_W, M.PAGE_H] : (this.sizes[i] || this.defSize()); }
  snap() { return this.pages.map((p) => ({ paper: p.paper, items: p.items.slice() })); }
  restoreSnap(s) { this.pages = s.map((p) => (this.kind === "nb" ? { paper: p.paper, items: p.items.slice() } : { items: p.items.slice() })); }

  // -------------------------------------------------------------------- DOM
  buildDom() {
    const mk = (cls) => el("div", { class: cls });
    this.titleEl = el("span", { class: "ptitle" });
    this.barsBtn = el("button", { class: "btn small", type: "button", onclick: () => this.setBars(!this.barsOpen), title: "Show or hide this panel's toolbars" });
    const head = el("header", { class: "phead" }, this.titleEl, this.barsBtn);

    this.fileInput = el("input", { type: "file", hidden: true, onchange: () => this.onFile() });
    this.imgInput = el("input", { type: "file", accept: "image/*", hidden: true, onchange: () => this.onImageFile() });
    const b = (ic, lbl, title, fn, cls = "") => {
      const x = el("button", { class: "btn " + cls, type: "button", title, "aria-label": title, onclick: fn }, icon(ic), lbl ? el("span", { class: "lbl" }, lbl) : null);
      return x;
    };
    this.b = {};
    const fileBar = mk("bar");
    if (this.kind === "pdf") {
      this.b.open = b("open", "Open", "Open a PDF", () => this.pickFile(".pdf,application/pdf"));
      this.b.save = b("save", "Save PDF", "Save a copy of the PDF with your annotations", () => this.saveAnnotated());
      fileBar.append(this.b.open, this.b.save);
    } else {
      this.b.new = b("plus", "New", "New notebook", () => this.newNotebook());
      this.b.open = b("open", "Open", "Open a notebook (.dnote)", () => this.pickFile(".dnote,application/json,.json"));
      this.b.save = b("save", "Save", "Save the notebook (.dnote)", () => this.saveNotebook());
      this.b.export = b("pdf", "PDF", "Export all pages as a PDF", () => this.exportNotebook());
      fileBar.append(this.b.new, this.b.open, this.b.save, this.b.export);
    }
    this.b.undo = b("undo", "", "Undo (Ctrl+Z)", () => this.undo());
    this.b.redo = b("redo", "", "Redo (Ctrl+Y)", () => this.redo());
    this.b.paste = b("paste", "Paste", "Paste an image (e.g. a screenshot) or text", () => this.app.pasteButton(this));
    this.b.image = b("image", "Image", "Insert an image from a file or the camera", () => this.imgInput.click());
    fileBar.append(el("span", { class: "gap" }), this.b.undo, this.b.redo, el("span", { class: "gap" }), this.b.paste, this.b.image);

    const pageBar = mk("bar");
    this.b.prev = b("prev", "", "Previous page", () => this.goto(this.cur - 1));
    this.pageInput = el("input", { type: "number", class: "pageno", min: 1, inputMode: "numeric", "aria-label": "Page number",
      onchange: () => this.goto(+this.pageInput.value - 1), onfocus: (e) => e.target.select() });
    this.pageCount = el("span", { class: "pcount" });
    this.b.next = b("next", "", "Next page", () => this.goto(this.cur + 1));
    this.b.zout = b("minus", "", "Zoom out", () => this.zoomBy(1 / 1.25));
    this.b.zin = b("plus", "", "Zoom in", () => this.zoomBy(1.25));
    this.b.fit = b("fit", "Fit", "Fit page to width", () => this.fitView());
    pageBar.append(this.b.prev, this.pageInput, this.pageCount, this.b.next, el("span", { class: "gap" }), this.b.zout, this.b.zin, this.b.fit);
    if (this.kind === "nb") {
      this.b.add = b("plus", "Page", "Insert a new page after this one", () => this.addPage());
      this.b.del = b("trash", "", "Delete this page", () => this.deletePage());
      this.b.earlier = b("prev", "Move", "Move this page earlier", () => this.movePage(-1), "mv");
      this.b.later = b("next", "Move", "Move this page later", () => this.movePage(1), "mv");
      this.paper = el("select", { class: "paper", "aria-label": "Paper", onchange: () => this.setPaper(this.paper.value) },
        el("option", { value: "blank" }, "Blank"), el("option", { value: "lined" }, "Lined"), el("option", { value: "grid" }, "Grid"));
      pageBar.append(el("span", { class: "gap" }), this.b.add, this.b.del, this.b.earlier, this.b.later, this.paper);
    }

    const toolBar = mk("bar tools");
    this.toolBtns = {};
    for (const k of (this.kind === "pdf" ? PDF_TOOLS : NB_TOOLS)) {
      let x;
      if (k === "shape") {          // one button for all shapes: shows the active shape, opens the shape menu
        this.shapeIcon = el("span", { class: "shico" }, icon(this.shapeKind));
        x = el("button", { class: "btn tool", type: "button", title: TOOL_INFO[k][1], "aria-label": TOOL_INFO[k][0], "aria-haspopup": "menu",
          "aria-pressed": "false", onclick: () => this.openShapes() }, this.shapeIcon, el("span", { class: "lbl" }, TOOL_INFO[k][0]), icon("chevdown", "tiny"));
        this.shapeBtn = x;
      } else {
        x = el("button", { class: "btn tool", type: "button", title: TOOL_INFO[k][1], "aria-label": TOOL_INFO[k][0],
          "aria-pressed": "false", onclick: () => this.setTool(k) }, icon(k), el("span", { class: "lbl" }, TOOL_INFO[k][0]));
      }
      this.toolBtns[k] = x; toolBar.append(x);
    }
    this.fillBtn = el("button", { class: "btn tool fillbtn", type: "button", "aria-label": "Fill", "aria-pressed": "false", disabled: true,
      title: "Fill closed shapes with the colour", onclick: () => this.toggleFill() }, icon("fill"), el("span", { class: "lbl" }, "Fill"));
    toolBar.append(this.fillBtn);
    this.colorBtn = el("button", { class: "btn", type: "button", title: "Choose a colour", onclick: () => this.openColor() },
      el("span", { class: "cdot" }), el("span", { class: "lbl" }, "Color"), icon("chevdown", "tiny"));
    this.brushBtn = el("button", { class: "btn", type: "button", title: "Thickness, opacity, brightness, text size", onclick: () => this.openBrush() },
      icon("brush"), el("span", { class: "lbl" }, "Brush"), icon("chevdown", "tiny"));
    const fb = (ic, title, fn) => el("button", { class: "btn tool fmt", type: "button", title, "aria-label": title, "aria-pressed": "false", onclick: fn }, icon(ic));
    this.fmtBtns = {
      ltr: fb("ltr", "Text direction: left-to-right (English)", () => this.setFmt({ dir: "ltr" })),
      rtl: fb("rtl", "Text direction: right-to-left (Persian)", () => this.setFmt({ dir: "rtl" })),
      left: fb("alignleft", "Align text to the left", () => this.setFmt({ align: "left" })),
      center: fb("aligncenter", "Center text", () => this.setFmt({ align: "center" })),
      right: fb("alignright", "Align text to the right", () => this.setFmt({ align: "right" })),
    };
    const F = this.fmtBtns;
    this.fmtGroup = el("span", { class: "fmtgrp", role: "group", "aria-label": "Text direction and alignment", hidden: true },
      F.ltr, F.rtl, el("span", { class: "fsep" }), F.left, F.center, F.right);
    for (const ev of ["pointerdown", "mousedown"]) this.fmtGroup.addEventListener(ev, (e) => e.preventDefault());   // keep the text cursor in the editor
    toolBar.append(this.fmtGroup, el("span", { class: "gap" }), this.colorBtn, this.brushBtn);

    this.bars = el("div", { class: "bars" }, fileBar, pageBar, toolBar);

    this.canvas = el("canvas", { class: "view", "aria-label": this.label });
    this.ctx = this.canvas.getContext("2d");
    this.ta = el("textarea", { class: "editor", hidden: true, rows: 1, dir: "auto", spellcheck: false, autocapitalize: "off",
      oninput: () => this.positionEditor(), onblur: () => this.finishEdit(),
      onkeydown: (e) => { if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.finishEdit(); } e.stopPropagation(); } });
    this.msg = el("div", { class: "msg" });
    this.stage = el("div", { class: "stage", tabIndex: -1 }, this.canvas, this.ta, this.msg);
    this.body = el("div", { class: "pbody" }, this.stage, this.bars);    // bars overlay the stage (position:absolute), they take no layout space
    this.root = el("section", { class: "panel", dataset: { key: this.key, kind: this.kind } }, head, this.body, this.fileInput, this.imgInput);

    const s = this.stage;
    s.addEventListener("pointerdown", (e) => this.onDown(e));
    s.addEventListener("pointermove", (e) => this.onMove(e));
    s.addEventListener("pointerup", (e) => this.onUp(e));
    s.addEventListener("pointercancel", (e) => this.onUp(e, true));
    s.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    s.addEventListener("contextmenu", (e) => e.preventDefault());
    this.root.addEventListener("pointerdown", () => this.app.setActive(this), true);
    this.root.addEventListener("focusin", () => this.app.setActive(this));
    this.setBars(true);
  }

  setBars(open) {
    this.barsOpen = open;
    this.bars.hidden = !open;
    this.barsBtn.textContent = open ? "Toolbars ▾" : "Toolbars ▸";   // the bars float over the page area: nothing is resized or moved
  }

  // ------------------------------------------------------------------- tools
  setTool(tool, silent = false) {
    this.finishEdit();
    this.tool = tool;
    for (const [k, x] of Object.entries(this.toolBtns)) { x.classList.toggle("on", k === tool); x.setAttribute("aria-pressed", String(k === tool)); }
    this.stage.dataset.tool = tool;
    if (tool !== "select" && this.selected !== null) this.selected = null;
    const g = GROUP_OF_TOOL[tool];
    if (g) this.curStyle = { ...this.groups[g] };
    this.updateColorDot();
    if (tool === "hltext") this.ensureWords();
    if (!silent) this.render();
  }
  groupKey() { return GROUP_OF_TOOL[this.tool] || null; }
  updateColorDot() { this.colorBtn.querySelector(".cdot").style.background = this.curStyle.color; }

  applyStyle(key, value, commit = true) {
    this.curStyle[key] = value;
    const g = this.groupKey();
    if (g) this.groups[g][key] = value;
    if (key === "color") this.updateColorDot();
    if (commit && this.tool === "select" && this.selected !== null) {
      const d = this.items[this.selected];
      if (!d) return;
      const field = STYLE_TO_ITEM[key];
      if (field in d || key === "alpha" || key === "bright") {
        const v = key === "width" || key === "size" ? Number(value) : value;
        const n = { ...d, [field]: v };
        if (key === "color" && d.fill) n.fill = v;                  // a filled shape stays filled with its colour
        if (JSON.stringify(n) !== JSON.stringify(d)) {
          const items = this.items.slice(); items[this.selected] = n;
          this.commit(items, { keepSel: true });
        }
      }
    }
    this.render();
  }
  rememberColor(hex) {
    this.recent = [hex, ...this.recent.filter((c) => c !== hex)].slice(0, 10);
  }
  openColor() {
    this.finishEdit();
    const pick = (hex) => { closePopup(); this.rememberColor(hex); this.applyStyle("color", hex); };
    popup(this.colorBtn, paletteContent({ recent: this.recent, onPick: pick,
      onCustom: async () => { closePopup(); const hex = await customColorDialog(this.curStyle.color); if (hex) pick(hex); } }));
  }
  openBrush() {
    this.finishEdit();
    const box = brushContent({ getStyle: () => this.curStyle, widthEnabled: this.tool !== "hltext",
      onInput: (k, v) => this.applyStyle(k, v, false), onCommit: (k, v) => this.applyStyle(k, v, true) });
    popup(this.brushBtn, box);
  }

  // ------------------------------------------------------------ view / zoom
  onResize() {
    const r = this.stage.getBoundingClientRect();
    if (this.root.hidden || r.width === 0 || r.height === 0) return;     // hidden panel (layout switch): keep its view exactly as it is
    this.cw = Math.max(50, Math.round(r.width)); this.ch = Math.max(50, Math.round(r.height));
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cw * this.dpr); this.canvas.height = Math.round(this.ch * this.dpr);
    this.canvas.style.width = this.cw + "px"; this.canvas.style.height = this.ch + "px";
    this.root.classList.toggle("narrow", r.width < 700);      // icons only, so the toolbars use fewer rows
    if (this.view.fit && this.hasPage) this.fitView(false); else this.clampView();
    this.positionEditor();
    this.render(); this.scheduleRaster();
  }
  fitView(userAction = true) {
    const doc = this.continuous() && this.offs, v = this.view;
    const w = doc ? this.sizeOf(this.vp)[0] : this.pageDims()[0];
    const margin = this.cw < 500 ? 6 : 14;
    const topDoc = doc ? -v.ty / v.scale : 0;                          // document position at the top edge of the view (kept when the width changes)
    v.scale = clamp((this.cw - 2 * margin) / w, 0.2, 6);
    v.fit = true;
    if (doc) {
      v.tx = (this.cw - this.docW * v.scale) / 2;
      v.ty = userAction ? margin - this.offs[this.vp] * v.scale : -topDoc * v.scale;
      this.clampView();
    } else { v.tx = (this.cw - w * v.scale) / 2; v.ty = margin; }
    if (userAction) { this.render(); this.scheduleRaster(); }
  }
  clampView(m = 80) {
    const v = this.view, s = v.scale;
    if (this.continuous() && this.offs) {                      // whole document = one tall column
      const dw = this.docW * s, dh = this.docH * s;
      v.tx = dw <= this.cw ? (this.cw - dw) / 2 : clamp(v.tx, this.cw - dw - m, m);
      v.ty = dh <= this.ch - 16 ? clamp(v.ty, 8, this.ch - dh - 8) : clamp(v.ty, this.ch - dh - m, m);
      return;
    }
    const [w, h] = this.pageDims(), pw = w * s, ph = h * s;
    v.tx = pw <= this.cw ? (this.cw - pw) / 2 : clamp(v.tx, this.cw - pw - m, m);
    v.ty = ph <= this.ch - 16 ? clamp(v.ty, 8, this.ch - ph - 8) : clamp(v.ty, this.ch - ph - m, m);
  }
  zoomAt(factor, cx, cy) {
    const old = this.view.scale, s = clamp(old * factor, 0.2, 6), k = s / old;
    this.view.tx = cx - (cx - this.view.tx) * k; this.view.ty = cy - (cy - this.view.ty) * k;
    this.view.scale = s; this.view.fit = false;
    this.clampView(); this.positionEditor(); this.render(); this.scheduleRaster();
  }
  zoomBy(f) { this.zoomAt(f, this.cw / 2, this.ch / 2); }
  /** Top-left corner of the active page, in document space (0,0 for a notebook page). */
  origin() {
    if (this.continuous() && this.offs) return [(this.docW - this.sizeOf(this.cur)[0]) / 2, this.offs[this.cur] || 0];
    return [0, 0];
  }
  pageToScreen(x, y) { const [ox, oy] = this.origin(), v = this.view; return [v.tx + (ox + x) * v.scale, v.ty + (oy + y) * v.scale]; }
  toPage(e) {
    const r = this.stage.getBoundingClientRect();
    return this.screenToPage(e.clientX - r.left, e.clientY - r.top);
  }
  screenToPage(sx, sy) { const [ox, oy] = this.origin(), v = this.view; return { x: (sx - v.tx) / v.scale - ox, y: (sy - v.ty) / v.scale - oy }; }
  clampP(p) { const [w, h] = this.pageDims(); return { x: clamp(p.x, 0, w), y: clamp(p.y, 0, h) }; }

  // ------------------------------------------- continuous PDF: layout of all pages
  // Every page has a slot in one tall column, so scrolling is smooth and page numbers are exact.
  // Page sizes are read lazily (20 at a time, a few pages before they are needed); until then a page
  // takes the size of page 1. Page bitmaps are only made for pages on / next to the screen.
  layout() {
    const n = this.pages.length, o = new Float64Array(n + 1);
    let y = 0, W = 0;
    for (let i = 0; i < n; i++) { const s = this.sizeOf(i); o[i] = y; y += s[1] + GAP; if (s[0] > W) W = s[0]; }
    o[n] = y; this.offs = o; this.docW = W || 595; this.docH = Math.max(1, y - GAP);
  }
  relayoutKeep() {                                   // sizes changed: keep the current page where it is on screen
    const had = this.offs, i = this.vp, before = had ? had[i] : 0;
    this.layout();
    if (had) this.view.ty -= (this.offs[i] - before) * this.view.scale;
    this.clampView(); this.positionEditor();
  }
  pageAt(y) {                                        // page whose slot starts at or above document-y
    const o = this.offs, n = this.pages.length;
    if (!o || n < 1) return 0;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (o[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo;
  }
  pageNearest(y) {
    const i = this.pageAt(y);
    return i < this.pages.length - 1 && y > this.offs[i] + this.sizeOf(i)[1] + GAP / 2 ? i + 1 : i;
  }
  visibleRange() {
    if (!this.offs) return [0, 0];
    const s = this.view.scale;
    return [this.pageAt(-this.view.ty / s), this.pageAt((this.ch - this.view.ty) / s)];
  }
  pageVisible(i) { const [lo, hi] = this.visibleRange(); return i >= lo && i <= hi; }
  syncVp() {                                         // which page is "the current one" while scrolling
    if (!this.offs) return;
    let v = this.pageNearest((0.35 * this.ch - this.view.ty) / this.view.scale);
    const L = this.vpLock;
    if (L) { if (Math.abs(this.view.ty - L.ty) < 1.5 && Math.abs(this.view.scale - L.s) < 1e-6) v = L.n; else this.vpLock = null; }
    if (v !== this.vp) this.onVp(v);
  }
  onVp(v) {
    this.vp = v;
    if ((!this.action || this.action.type === "pan") && this.selected === null && !this.editing) this.setCur(v);
    this.updatePageUi();
    this.ensureSizesAround();
  }
  updatePageUi() {
    const n = this.pages.length, has = this.hasPage, v = this.shown();
    if (document.activeElement !== this.pageInput) this.pageInput.value = has ? v + 1 : "";
    this.b.prev.disabled = !(has && v > 0); this.b.next.disabled = !(has && v < n - 1);
    if (this.kind === "nb") {
      this.b.earlier.disabled = !(has && v > 0); this.b.later.disabled = !(has && v < n - 1);
      this.paper.value = this.pages[v]?.paper || "lined";
    }
  }
  /** Make page i the page that drawing / editing applies to. */
  setCur(i) {
    if (i === this.cur) return false;
    this.cur = i; this.selected = null; this.live = null; this.preview = null;
    this.words = null; this.wordsPage = -1;
    if (this.tool === "hltext") this.ensureWords();
    return true;
  }
  activateAt(sy) {                                   // page under screen-y becomes the active page
    if (!this.continuous() || !this.offs) return;
    const i = this.pageNearest((sy - this.view.ty) / this.view.scale);
    if (this.setCur(i)) this.ui();
  }
  scrollToPage(n) {
    if (!this.offs) return;
    n = clamp(Math.round(n) || 0, 0, this.pages.length - 1);
    this.setCur(n); this.vp = n;
    const margin = this.cw < 500 ? 6 : 14;
    this.view.ty = margin - this.offs[n] * this.view.scale;
    this.clampView(); this.positionEditor();
    this.vpLock = { n, ty: this.view.ty, s: this.view.scale };
    this.ui(); this.render(); this.scheduleRaster(); this.ensureSizesAround();
  }
  ensureWords() {                                    // text boxes of the active page (for the Highlight tool)
    if (this.kind !== "pdf" || !this.pdf || this.wordsPage === this.cur) return;
    const i = this.cur, doc = this.pdf.doc;
    this.wordsPage = i; this.words = null;
    PDF.pageWords(doc, i).then((w) => { if (this.pdf && this.pdf.doc === doc && this.cur === i) this.words = w; })
      .catch(() => { if (this.wordsPage === i) this.wordsPage = -1; });
  }
  loadSizes(lo, hi) {
    const doc = this.pdf && this.pdf.doc;
    if (!doc) return Promise.resolve();
    const ok = () => this.pdf && this.pdf.doc === doc, jobs = [];
    for (let i = Math.max(0, lo); i < Math.min(this.pages.length, hi); i++) {
      if (this.sizes[i]) continue;
      let j = this.sizeJobs.get(i);
      if (!j) {
        j = PDF.pageSize(doc, i).then((s) => { if (ok()) this.sizes[i] = s; })
          .catch(() => { if (ok()) this.sizes[i] = this.defSize(); })
          .finally(() => this.sizeJobs.delete(i));
        this.sizeJobs.set(i, j);
      }
      jobs.push(j);
    }
    if (!jobs.length) return Promise.resolve();
    return Promise.all(jobs).then(() => { if (ok()) { this.relayoutKeep(); this.render(); this.scheduleRaster(); } });
  }
  ensureSizesAround() {                              // when within 5 pages of the loaded end, read the next 20 sizes
    if (!this.offs || this.kind !== "pdf") return;
    const n = this.pages.length, v = this.vp, [lo, hi] = this.visibleRange();
    let m = -1;
    for (let i = v; i <= Math.min(n - 1, v + 5); i++) if (!this.sizes[i]) { m = i; break; }
    if (m >= 0) this.loadSizes(m, m + 20).catch(() => {});
    m = -1;
    for (let i = v - 1; i >= Math.max(0, v - 5); i--) if (!this.sizes[i]) { m = i; break; }
    if (m >= 0) this.loadSizes(m - 19, m + 1).catch(() => {});
    this.loadSizes(lo, hi + 1).catch(() => {});
  }
  resetDoc() {                                       // called when another PDF is opened / closed
    this.rasterJob?.cancel(); this.rasterJob = null; clearTimeout(this.rasterTimer); this.stopFling();
    for (const r of this.rasters.values()) freeCanvas(r.canvas);
    this.rasters.clear(); this.badPages = new Set(); this.sizeJobs = new Map();
    this.sizes = []; this.offs = null; this.vp = 0; this.vpLock = null; this.words = null; this.wordsPage = -1;
  }

  // ----------------------------------------------------- touch momentum scroll
  stopFling() { if (this.fling) { cancelAnimationFrame(this.fling); this.fling = 0; } }
  flingFrom(samples) {
    const now = performance.now(), s = (samples || []).filter((p) => now - p.t < 100);
    if (s.length < 2) return;
    const a = s[0], b = s[s.length - 1], dt = b.t - a.t;
    if (dt < 8) return;
    const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
    if (Math.hypot(vx, vy) < 0.15) return;
    this.startFling(vx, vy);
  }
  startFling(vx, vy) {
    this.stopFling();
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(50, now - last); last = now;
      const v = this.view; v.tx += vx * dt; v.ty += vy * dt;
      const px = v.tx, py = v.ty; this.clampView();
      if (v.tx !== px) vx = 0;
      if (v.ty !== py) vy = 0;
      const k = Math.exp(-dt / 325); vx *= k; vy *= k;
      this.render(); this.scheduleRaster();
      this.fling = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    this.fling = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------- PDF page bitmaps
  wantFor(i) {                                       // bitmap scale for page i at the current zoom
    const [w, h] = this.sizeOf(i);
    let want = clamp(this.view.scale * this.dpr, 0.5, 6);
    while (w * want * h * want > 14e6 && want > 0.5) want *= 0.9;
    return want;
  }
  needsRaster(i) {
    if (this.badPages.has(i)) return false;
    const r = this.rasters.get(i), want = this.wantFor(i);
    return !r || r.scale < want * 0.9 || r.scale > want * 2.5;
  }
  missingVisible() {
    const [lo, hi] = this.visibleRange();
    for (let i = lo; i <= hi; i++) if (!this.rasters.has(i) && !this.badPages.has(i)) return true;
    return false;
  }
  scheduleRaster() {
    if (this.kind !== "pdf" || !this.pdf || !this.offs) return;
    clearTimeout(this.rasterTimer);
    // a page that is on screen with no bitmap yet starts at once; re-sharpening after a zoom waits for it to settle
    this.rasterTimer = setTimeout(() => this.pumpRaster(), this.missingVisible() ? 0 : 120);
  }
  async pumpRaster() {
    if (this.kind !== "pdf" || !this.pdf || !this.offs) return;
    this.ensureSizesAround();
    const doc = this.pdf.doc, n = this.pages.length, [lo, hi] = this.visibleRange(), c = this.vp, wanted = [];
    let px = 0;
    for (const r of this.rasters.values()) px += r.canvas.width * r.canvas.height;
    for (let i = Math.max(0, lo - 1); i <= Math.min(n - 1, hi + 1); i++) {
      if (!this.needsRaster(i)) continue;
      if (i < lo || i > hi) {                      // pre-render of a neighbour: only if it fits in the memory budget (else it would be evicted at once)
        const [w, h] = this.sizeOf(i), want = this.wantFor(i);
        if (px + w * want * h * want > RASTER_BUDGET || (!this.rasters.has(i) && this.rasters.size >= RASTER_MAX)) continue;
      }
      wanted.push(i);
    }
    const vis = (i) => (i >= lo && i <= hi ? 0 : 1);
    wanted.sort((a, b) => vis(a) - vis(b) || Math.abs(a - c) - Math.abs(b - c));
    const cur = this.rasterJob;
    if (cur) {
      if (wanted.includes(cur.page) && Math.abs(cur.scale / this.wantFor(cur.page) - 1) < 0.1) return;   // still useful: let it finish
      cur.cancel();
    }
    if (!wanted.length) { this.evictRasters(); return; }
    const i = wanted[0], want = this.wantFor(i), j = PDF.renderRaster(doc, i, want);
    const job = { page: i, scale: want, cancel: () => j.cancel() };
    this.rasterJob = job;
    try {
      const canvas = await j.promise;
      if (canvas && this.pdf && this.pdf.doc === doc) {
        const old = this.rasters.get(i);
        this.rasters.set(i, { canvas, scale: want });
        if (old) freeCanvas(old.canvas);
        this.evictRasters(); this.render();
      } else if (canvas) freeCanvas(canvas);
    } catch (e) {
      if (this.pdf && this.pdf.doc === doc) { console.error(e); this.badPages.add(i); }
    } finally { if (this.rasterJob === job) this.rasterJob = null; }
    if (this.pdf && this.pdf.doc === doc) this.pumpRaster();
  }
  evictRasters() {                                   // keep memory low: drop bitmaps of pages far from the screen
    if (!this.offs || !this.pdf) return;
    const [lo, hi] = this.visibleRange(), c = this.vp, doc = this.pdf.doc;
    let total = 0;
    for (const r of this.rasters.values()) total += r.canvas.width * r.canvas.height;
    const order = [...this.rasters.keys()].filter((i) => i < lo || i > hi).sort((a, b) => Math.abs(b - c) - Math.abs(a - c));
    for (const i of order) {
      const r = this.rasters.get(i), far = i < lo - 2 || i > hi + 2;
      if (!(far || total > RASTER_BUDGET || this.rasters.size > RASTER_MAX)) continue;
      total -= r.canvas.width * r.canvas.height;
      freeCanvas(r.canvas); this.rasters.delete(i); PDF.releasePage(doc, i);
    }
  }

  // ----------------------------------------------------------------- drawing
  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }
  draw() {
    const ctx = this.ctx, d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.fillStyle = "#c9ccd1"; ctx.fillRect(0, 0, this.cw, this.ch);
    this.updateFmtUi(); this.updateFillUi();
    this.msg.hidden = this.hasPage;
    if (!this.hasPage) return;
    this.drawDoc(ctx);
  }
  /** Continuous view (PDF and notebook): draws only the pages that are on screen. */
  drawDoc(ctx) {
    if (!this.offs) return;
    this.syncVp();
    const v = this.view, s = v.scale, [lo, hi] = this.visibleRange();
    ctx.save();
    ctx.translate(v.tx, v.ty); ctx.scale(s, s);
    for (let i = lo; i <= hi; i++) {
      const [w, h] = this.sizeOf(i), isCur = i === this.cur;
      ctx.save();
      ctx.translate((this.docW - w) / 2, this.offs[i]);
      ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 8 / s; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.shadowColor = "transparent";
      if (this.kind === "nb") R.drawPaper(ctx, w, h, this.pages[i].paper);
      else { const r = this.rasters.get(i); if (r) { ctx.imageSmoothingQuality = "high"; ctx.drawImage(r.canvas, 0, 0, w, h); } }
      const list = isCur ? this.drawList : this.pages[i].items;
      if (list.length || (isCur && this.preview)) {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
        for (let k = 0; k < list.length; k++) R.drawItem(ctx, list[k], { skipText: isCur && !!this.editing && this.editing.idx === k });
        if (isCur && this.preview) for (const p of [].concat(this.preview)) R.drawItem(ctx, p);
        ctx.restore();
      }
      if (isCur && this.selected !== null && list[this.selected]) this.drawSelection(ctx, list[this.selected]);
      ctx.restore();
    }
    ctx.restore();
    const list = this.drawList;
    if (this.selected !== null && list[this.selected] && !this.editing) this.drawHandles(ctx, list[this.selected]);
  }
  geom(i, list = this.drawList) {
    const d = list[i];
    return d.t === "text" ? R.textBox(d) : M.geomBox(d);
  }
  selInfo(d, i) {
    const g = this.geom(i), e = 3 / Math.max(1, this.view.scale * 0.6) + M.halfWidth(d);      // handle gap in page units
    return { g, e, pos: M.handlePositions(d, g, e) };
  }
  drawSelection(ctx, d) {
    if (this.editing) return;
    const i = this.selected, { g, e } = this.selInfo(d, i), s = this.view.scale;
    ctx.save();
    ctx.strokeStyle = "#1976d2"; ctx.lineWidth = 1.4 / s; ctx.setLineDash([5 / s, 4 / s]);
    if (d.t === "line" || d.t === "arrow") ctx.strokeRect(g[0] - e, g[1] - e, g[2] - g[0] + 2 * e, g[3] - g[1] + 2 * e);
    else ctx.strokeRect(g[0] - e, g[1] - e, g[2] - g[0] + 2 * e, g[3] - g[1] + 2 * e);
    ctx.restore();
  }
  drawHandles(ctx, d) {
    const { pos } = this.selInfo(d, this.selected), v = this.view;
    ctx.save(); ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    for (const [x, y] of Object.values(pos)) {
      const [hx, hy] = this.pageToScreen(x, y);
      ctx.beginPath(); ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = "#fff"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#1976d2"; ctx.stroke();
    }
    ctx.restore();
  }
  handleAt(sx, sy, ptype) {
    if (this.selected === null || !this.items[this.selected]) return null;
    const { pos } = this.selInfo(this.items[this.selected], this.selected, this.items), v = this.view;
    const r = ptype === "touch" ? 24 : 14;
    let best = null, bd = r;
    for (const [name, [x, y]] of Object.entries(pos)) {
      const [px, py] = this.pageToScreen(x, y), d = Math.hypot(px - sx, py - sy);
      if (d <= bd) { bd = d; best = name; }
    }
    return best;
  }

  // -------------------------------------------------------------- hit testing
  tol() { return Math.max(3, 10 / this.view.scale); }
  hitItem(list, i, p, tol) {
    const d = list[i];
    if (d.t === "text") { const b = R.textBox(d); return p.x >= b[0] - tol && p.x <= b[2] + tol && p.y >= b[1] - tol && p.y <= b[3] + tol; }
    return M.hitTest(d, p.x, p.y, tol);
  }
  hit(p, list = this.items) {
    const tol = this.tol();
    for (let i = list.length - 1; i >= 0; i--) if (this.hitItem(list, i, p, tol)) return i;
    return null;
  }

  // ------------------------------------------------------------- committing
  commit(newItems, { keepSel = false, select = null } = {}) {
    this.history.push(this.snap(), this.cur);
    this.pages[this.cur].items = newItems;
    this.live = null; this.preview = null;
    this.selected = select !== null ? select : (keepSel ? this.selected : null);
    if (this.selected !== null && this.selected >= newItems.length) this.selected = null;
    this.dirty = true;
    this.app.onChange(this);
    this.ui(); this.render();
  }
  undo() { if (this.editing) return; if (this.history.canUndo()) this.historyStep(this.history.undoStep(this.snap())); }
  redo() { if (this.editing) return; if (this.history.canRedo()) this.historyStep(this.history.redoStep(this.snap())); }
  async historyStep([state, idx]) {
    this.restoreSnap(state);
    this.selected = null; this.live = null; this.preview = null; this.dirty = true;
    idx = clamp(idx, 0, this.pages.length - 1);
    if (this.kind === "nb") { this.layout(); this.vp = clamp(this.vp, 0, this.pages.length - 1); this.clampView(); }   // pages may have been added / removed
    this.setCur(idx);
    if (!this.pageVisible(idx)) this.scrollToPage(idx); else this.ui();
    this.render();
    this.app.onChange(this); this.ui();
  }

  // ----------------------------------------------------------------- pointers
  styleExtra() { return { alpha: this.curStyle.alpha, bright: this.curStyle.bright }; }
  onWheel(e) {
    e.preventDefault();
    if (!this.hasPage) return;
    this.stopFling();
    const r = this.stage.getBoundingClientRect(), k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.ch : 1;
    if (e.ctrlKey || e.metaKey) { this.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top); return; }
    this.view.tx -= (e.shiftKey ? e.deltaY : e.deltaX) * k; this.view.ty -= (e.shiftKey ? 0 : e.deltaY) * k;
    if (!this.continuous()) this.view.fit = false;
    this.clampView(); this.positionEditor(); this.render(); this.scheduleRaster();
  }
  local(e) { const r = this.stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  onDown(e) {
    if (!this.hasPage || e.button > 0) return;
    this.stopFling();
    const wasEditing = !!this.editing && e.target !== this.ta;
    if (wasEditing) this.finishEdit();
    if (e.target === this.ta) return;
    e.preventDefault();
    this.stage.setPointerCapture(e.pointerId);
    const l = this.local(e);
    this.pointers.set(e.pointerId, { x: l.x, y: l.y, type: e.pointerType });
    if (wasEditing && this.pointers.size === 1) { this.action = { type: "none" }; return; }       // this tap only closes the editor
    if (e.pointerType === "pen") this.lastPen = performance.now();
    if (this.pointers.size === 2) { this.startGesture(); return; }
    if (this.pointers.size > 2) return;
    if (e.pointerType === "touch" && performance.now() - this.lastPen < 1200) { this.action = { type: "palm" }; return; }   // palm rejection while a pen is in use
    closePopup();
    this.toolDown(e, l);
  }
  onMove(e) {
    const pt = this.pointers.get(e.pointerId);
    if (!pt) return;
    const l = this.local(e); pt.x = l.x; pt.y = l.y;
    if (this.gesture) { this.updateGesture(); return; }
    if (!this.action) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    this.toolMove(e, l, evs.length ? evs : [e]);
  }
  onUp(e, cancelled = false) {
    const had = this.pointers.delete(e.pointerId);
    if (!had) return;
    try { this.stage.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (this.gesture) { if (this.pointers.size < 2) this.gesture = null; this.action = null; return; }
    if (!this.action) return;
    if (cancelled) { this.cancelAction(); return; }
    this.toolUp(e, this.local(e));
  }
  startGesture() {
    this.cancelAction();
    const [a, b] = [...this.pointers.values()];
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this.gesture = { dist, scale: this.view.scale, wx: (cx - this.view.tx) / this.view.scale, wy: (cy - this.view.ty) / this.view.scale };
  }
  updateGesture() {
    const [a, b] = [...this.pointers.values()], g = this.gesture;
    if (!b) return;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this.view.scale = clamp(g.scale * dist / g.dist, 0.2, 6); this.view.fit = false;
    this.view.tx = cx - g.wx * this.view.scale; this.view.ty = cy - g.wy * this.view.scale;
    this.clampView(); this.positionEditor(); this.render(); this.scheduleRaster();
  }
  cancelAction() { this.action = null; this.preview = null; this.live = null; this.render(); }

  toolDown(e, l) {
    if (this.continuous() && this.tool !== "pan") {        // the page under the finger/pen becomes the active page
      const onHandle = this.tool === "select" && this.handleAt(l.x, l.y, e.pointerType);
      if (!onHandle) this.activateAt(l.y);
    }
    if (this.tool === "hltext") this.ensureWords();
    const p = this.toPage(e), t = this.tool;
    if (t === "pan") { this.action = { type: "pan", last: l }; return; }
    if (t === "select") {
      const h = this.handleAt(l.x, l.y, e.pointerType);
      if (h) {
        this.action = { type: "resize", h, orig: this.items[this.selected], tbox: this.geom(this.selected, this.items), base: this.items.slice(), e: this.selInfo(this.items[this.selected], this.selected).e };
        return;
      }
      const idx = this.hit(p);
      if (idx !== null) { this.selected = idx; this.action = { type: "move", idx, p0: p, orig: this.items[idx], moved: false, l0: l }; this.render(); }
      else { this.selected = null; this.action = { type: "pan", last: l, tap: true, l0: l }; this.render(); }
      return;
    }
    if (t === "pen" || t === "mark") {
      const c = this.clampP(p);
      this.action = { type: "stroke", pts: [[c.x, c.y]] };
      this.updateStrokePreview();
      return;
    }
    if (t === "shape" || t === "hltext") { this.action = { type: "shape", p0: this.clampP(p), l0: l, moved: false }; return; }
    if (t === "eraser") { this.live = this.items.slice(); this.action = { type: "erase" }; this.eraseAt(p); return; }
    if (t === "text" || t === "note") { this.action = { type: "tap", p, l0: l, moved: false }; return; }
  }
  toolMove(e, l, evs) {
    const a = this.action;
    if (a.type === "palm" || a.type === "none") return;
    if (a.type === "pan") {
      this.view.tx += l.x - a.last.x; this.view.ty += l.y - a.last.y; a.last = l;
      if (!this.continuous()) this.view.fit = false;
      (a.samples || (a.samples = [])).push({ t: performance.now(), x: l.x, y: l.y }); if (a.samples.length > 8) a.samples.shift();
      if (a.l0 && Math.hypot(l.x - a.l0.x, l.y - a.l0.y) > 6) a.tap = false;
      this.clampView(); this.render(); this.scheduleRaster(); return;
    }
    const p = this.toPage(e);
    if (a.type === "stroke") {
      for (const ev of evs) {
        const c = this.clampP(this.toPage(ev)), last = a.pts[a.pts.length - 1];
        if (Math.hypot(c.x - last[0], c.y - last[1]) >= 0.4) a.pts.push([c.x, c.y]);
      }
      this.updateStrokePreview(); return;
    }
    if (a.type === "shape") {
      if (Math.hypot(l.x - a.l0.x, l.y - a.l0.y) > 3) a.moved = true;
      this.preview = this.shapeItems(a.p0, this.clampP(p), e.shiftKey); this.render(); return;
    }
    if (a.type === "erase") { this.eraseAt(p); return; }
    if (a.type === "move") {
      const dx = p.x - a.p0.x, dy = p.y - a.p0.y;
      if (!a.moved && Math.hypot(l.x - a.l0.x, l.y - a.l0.y) > 4) a.moved = true;
      if (a.moved) { this.live = this.items.slice(); this.live[a.idx] = M.translate(a.orig, dx, dy); this.render(); }
      return;
    }
    if (a.type === "resize") {
      const c = this.clampP(p);
      this.live = this.items.slice();
      this.live[this.selected] = M.resizeItem(a.orig, a.h, c.x, c.y, a.tbox, a.e, e.shiftKey);
      this.render(); return;
    }
    if (a.type === "tap" && Math.hypot(l.x - a.l0.x, l.y - a.l0.y) > 8) a.moved = true;
  }
  toolUp(e, l) {
    const a = this.action; this.action = null;
    if (a.type === "palm" || a.type === "none") return;
    const p = this.toPage(e);
    if (a.type === "pan") {
      if (a.tap) this.tapSelect(null, l);
      else if (this.continuous() && e.pointerType === "touch") this.flingFrom(a.samples);
      return;
    }
    if (a.type === "stroke") {
      const pts = a.pts.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
      const st = this.curStyle;
      this.commit([...this.items, { t: this.tool, pts, color: st.color, w: st.width, ...this.styleExtra() }]);
      return;
    }
    if (a.type === "shape") {
      const c = this.clampP(p);
      this.preview = null;
      if (this.tool === "hltext") {
        const items = this.shapeItems(a.p0, c, false);
        if (items.length && Math.hypot(c.x - a.p0.x, c.y - a.p0.y) >= 3) this.commit([...this.items, ...items]); else this.render();
      } else if (Math.hypot(c.x - a.p0.x, c.y - a.p0.y) >= 2) this.commit([...this.items, this.shapeItems(a.p0, c, e.shiftKey)[0]]);
      else this.render();
      return;
    }
    if (a.type === "erase") {
      const live = this.live; this.live = null;
      if (live && live.length !== this.items.length) this.commit(live); else this.render();
      return;
    }
    if (a.type === "move") {
      const live = this.live; this.live = null;
      if (a.moved && live) { const dx = p.x - a.p0.x, dy = p.y - a.p0.y; if (Math.hypot(dx, dy) >= 0.5) { this.commit(live, { keepSel: true }); return; } }
      this.render(); this.tapSelect(a.idx, l); return;
    }
    if (a.type === "resize") {
      const live = this.live; this.live = null;
      if (live && JSON.stringify(live[this.selected]) !== JSON.stringify(this.items[this.selected])) this.commit(live, { keepSel: true }); else this.render();
      return;
    }
    if (a.type === "tap" && !a.moved) this.tapCreate(a.p);
  }
  deleteSelected() {
    if (this.selected === null || this.editing || !this.items[this.selected]) return false;
    const items = this.items.slice(); items.splice(this.selected, 1);
    this.commit(items); return true;
  }
  deselect() { if (this.selected !== null) { this.selected = null; this.render(); } }
  async saveSeparately() { return this.kind === "pdf" ? this.saveAnnotated() : this.saveNotebook(); }
  tapSelect(idx, l) {                       // double-tap on text / note edits it
    const now = performance.now(), prev = this.lastTap;
    if (idx !== null && idx !== undefined && prev && prev.idx === idx && now - prev.t < 450) {
      const d = this.items[idx];
      if (d && (d.t === "text" || d.t === "note")) { this.lastTap = null; this.startEdit(idx); return; }
    }
    this.lastTap = idx === null ? null : { idx, t: now };
    this.app.onSelect?.(this);
    this.syncStyleToSelection();
  }
  syncStyleToSelection() {
    if (this.tool !== "select" || this.selected === null) return;
    const d = this.items[this.selected];
    if (!d) return;
    this.curStyle = { color: d.color ?? this.curStyle.color, width: d.w ?? this.curStyle.width, size: d.size ?? this.curStyle.size,
      alpha: M.itemAlpha(d), bright: M.itemBright(d) };
    this.updateColorDot();
  }
  tapCreate(p) {
    const t = this.tool, idx = this.hit(p), [w, h] = this.pageDims(), st = this.curStyle;
    if (idx !== null && this.items[idx].t === t) { this.selected = idx; this.startEdit(idx); return; }
    if (t === "text") {
      const bw = Math.min(M.TEXT_BOX_W, w - 8), f = this.fmt;     // new text is a box of fixed width, so alignment is visible; RTL boxes grow leftwards from the tap
      const proto = { t: "text", x: clamp(f.dir === "rtl" ? p.x - bw : p.x, 4, w - bw - 4), y: clamp(p.y - st.size * 0.7, 0, h - 10), w: bw, dir: f.dir, align: f.align,
        text: "", color: st.color, size: st.size, ...this.styleExtra() };
      this.startEdit(null, proto);
    } else {
      const proto = { t: "note", x: clamp(p.x, 0, w - M.NOTE_W), y: clamp(p.y, 0, h - M.NOTE_H), w: M.NOTE_W, h: M.NOTE_H, dir: this.fmt.dir, align: this.fmt.align,
        text: "", color: st.color, size: st.size, ...this.styleExtra() };
      this.startEdit(null, proto);
    }
  }
  updateStrokePreview() {
    const st = this.curStyle;
    this.preview = { t: this.tool, pts: this.action.pts, color: st.color, w: st.width, ...this.styleExtra() };
    this.render();
  }
  shapeItems(a, b, shift) {
    const st = this.curStyle;
    if (this.tool === "hltext") return this.regionRects(a, b).map((r) => ({ t: "hl", x1: r[0], y1: r[1], x2: r[2], y2: r[3], color: st.color, ...this.styleExtra() }));
    const kind = M.shapeKindInfo(this.shapeKind);
    let x2 = b.x, y2 = b.y;
    if (shift && kind.closed) {
      const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      x2 = a.x + (b.x >= a.x ? s : -s); y2 = a.y + (b.y >= a.y ? s : -s);
    }
    const r2 = (v) => Math.round(v * 100) / 100;
    const item = { t: kind.t, x1: r2(a.x), y1: r2(a.y), x2: r2(x2), y2: r2(y2), color: st.color, w: st.width, ...this.styleExtra() };
    if (kind.t === "shape") item.kind = kind.id;
    if (kind.closed && this.fillOn) item.fill = st.color;                 // Fill on: interior in the drawing colour, outline stays
    return [item];
  }
  eraseAt(p) {
    const tol = this.tol(), live = this.live;
    const keep = live.filter((_, i) => !this.hitItem(live, i, p, tol));
    if (keep.length !== live.length) { this.live = keep; this.selected = null; this.render(); }
  }
  /** Rectangles (one per text line) covering the words between a and b (reading order). */
  regionRects(a, b) {
    const words = this.words;
    if (!words || !words.length) return [];
    const nearest = (pt) => {
      let best = 0, bd = Infinity;
      words.forEach((w, i) => {
        const dx = Math.max(w.x0 - pt.x, 0, pt.x - w.x1), dy = Math.max(w.y0 - pt.y, 0, pt.y - w.y1), d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    };
    const i = nearest(a), j = nearest(b), lo = Math.min(i, j), hi = Math.max(i, j), lines = new Map();
    for (const w of words.slice(lo, hi + 1)) {
      const r = lines.get(w.line);
      if (!r) lines.set(w.line, [w.x0, w.y0, w.x1, w.y1]);
      else { r[0] = Math.min(r[0], w.x0); r[1] = Math.min(r[1], w.y0); r[2] = Math.max(r[2], w.x1); r[3] = Math.max(r[3], w.y1); }
    }
    return [...lines.values()].map((r) => r.map((v) => Math.round(v * 100) / 100));
  }

  // ------------------------------------------------------- shapes + fill
  openShapes() {
    this.finishEdit();
    if (this.tool !== "shape") this.setTool("shape");
    const grid = el("div", { class: "shapegrid", role: "menu" }, M.SHAPE_KINDS.map((k) => el("button", {
      class: "shp" + (k.id === this.shapeKind ? " on" : ""), type: "button", role: "menuitemradio", "aria-checked": String(k.id === this.shapeKind),
      title: k.label, "aria-label": k.label, onclick: () => { closePopup(); this.setShape(k.id); } }, icon(k.id), el("span", { class: "slab" }, k.label))));
    popup(this.shapeBtn, grid);                      // pressing the Shapes button again closes the menu
  }
  setShape(id) {
    this.shapeKind = M.shapeKindInfo(id).id;
    this.updateShapeBtn();
    this.setTool("shape");
    this.fillKey = ""; this.updateFillUi();
  }
  updateShapeBtn() {
    const k = M.shapeKindInfo(this.shapeKind);
    this.shapeIcon.replaceChildren(icon(k.id));
    this.shapeBtn.title = "Shapes - active: " + k.label;
  }
  fillTarget() {                                     // a selected closed shape (the Fill button then edits that shape)
    if (this.tool === "select" && this.selected !== null) { const d = this.items[this.selected]; if (d && M.isClosedShape(d)) return d; }
    return null;
  }
  fillEnabled() { return !!this.fillTarget() || (this.tool === "shape" && M.shapeKindInfo(this.shapeKind).closed); }
  updateFillUi() {
    const en = this.fillEnabled(), d = this.fillTarget(), on = en && (d ? !!d.fill : this.fillOn), key = en + "|" + on;
    if (key === this.fillKey) return;
    this.fillKey = key;
    this.fillBtn.disabled = !en; this.fillBtn.classList.toggle("on", on); this.fillBtn.setAttribute("aria-pressed", String(on));
    this.fillBtn.title = en ? `Fill closed shapes with the colour: ${on ? "on" : "off"}` : "Fill applies to closed shapes (rectangle, ellipse, ...); lines have no interior";
  }
  toggleFill() {
    const d = this.fillTarget();
    if (d) {
      const n = { ...d };
      if (d.fill) delete n.fill; else n.fill = d.color;
      const items = this.items.slice(); items[this.selected] = n; this.commit(items, { keepSel: true });
      this.fillOn = !!n.fill;
    } else if (this.fillEnabled()) this.fillOn = !this.fillOn;
    this.fillKey = ""; this.updateFillUi(); this.render();
  }

  // ------------------------------------------------- text direction / alignment
  // dir (ltr|rtl) and align (left|center|right) are separate item properties. Old items without them keep the previous
  // behaviour (direction detected per line). this.fmt is what NEW text gets; it only changes when the user presses a button.
  textTarget() {                                     // the text / note the format buttons act on
    if (this.editing) return this.editing.idx !== null ? this.items[this.editing.idx] : this.editing.proto;
    if (this.tool === "select" && this.selected !== null) { const d = this.items[this.selected]; if (d && (d.t === "text" || d.t === "note")) return d; }
    return null;
  }
  displayFmt() {
    const d = this.textTarget();
    if (this.editing && this.editing.fmt) return this.editing.fmt;
    return d ? R.effectiveFmt(d) : this.fmt;
  }
  updateFmtUi() {
    const show = !!this.textTarget() || this.tool === "text" || this.tool === "note";
    const f = show ? this.displayFmt() : null, key = f ? f.dir + "|" + f.align : "";
    if (key === this.fmtKey) return;
    this.fmtKey = key; this.fmtGroup.hidden = !show;
    if (!f) return;
    const on = { ltr: f.dir === "ltr", rtl: f.dir === "rtl", left: f.align === "left", center: f.align === "center", right: f.align === "right" };
    for (const [k, b] of Object.entries(this.fmtBtns)) { b.classList.toggle("on", on[k]); b.setAttribute("aria-pressed", String(on[k])); }
  }
  setFmt(patch) {
    this.fmt = { ...this.fmt, ...patch };            // an explicit choice also becomes the default for new text
    const ed = this.editing;
    if (ed) {
      const d = ed.idx !== null ? this.items[ed.idx] : ed.proto;
      ed.fmt = { ...(ed.fmt || R.effectiveFmt(d)), ...patch };
      this.positionEditor(); this.ta.focus({ preventScroll: true });
    } else {
      const d = this.textTarget();
      if (d) {
        const f = { ...R.effectiveFmt(d), ...patch };
        if (f.dir !== d.dir || f.align !== d.align) { const items = this.items.slice(); items[this.selected] = { ...d, ...f }; this.commit(items, { keepSel: true }); }
      }
    }
    this.fmtKey = ""; this.updateFmtUi(); this.render();
  }

  // --------------------------------------------------------------- text edit
  startEdit(idx, proto = null) {
    this.finishEdit();
    const d = idx !== null ? this.items[idx] : proto;
    this.editing = { idx, proto, fmt: null };
    this.ta.value = d.text || "";
    this.ta.hidden = false;
    this.editingItem = d;
    this.positionEditor();
    this.render();
    this.ta.focus({ preventScroll: true });
    this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length);
  }
  positionEditor() {
    if (!this.editing) return;
    const d = this.editing.idx !== null ? this.items[this.editing.idx] : this.editing.proto, v = this.view, ta = this.ta, s = v.scale;
    if (!d) return;
    const [ox, oy] = this.origin();
    const f = this.editing.fmt || R.fmtOf(d);          // explicit format, or null = old item (direction auto-detected)
    ta.dir = f ? f.dir : "auto"; ta.style.textAlign = f ? f.align : "start";   // the browser's own bidi / shaping / caret handling
    ta.style.fontSize = d.size * s + "px"; ta.style.lineHeight = "1.25"; ta.style.fontFamily = R.FONT_STACK;
    if (d.t === "note") {
      ta.style.left = v.tx + (ox + d.x + 8) * s + "px"; ta.style.top = v.ty + (oy + d.y + M.NOTE_HEADER + 4) * s + "px";
      ta.style.width = R.noteTextWidth(d) * s + "px"; ta.style.height = Math.max(40, (d.h - M.NOTE_HEADER - 8)) * s + "px";
      ta.style.color = M.noteTextColor({ color: d.color, bright: M.itemBright(d) }); ta.style.background = "transparent"; ta.classList.add("note");
    } else {
      const mw = R.textInnerWidth(d), L = R.layoutText(R.measureCtx(), ta.value || " ", d.size, mw, f);
      ta.style.left = v.tx + (ox + d.x + R.TEXT_PAD) * s + "px"; ta.style.top = v.ty + (oy + d.y + R.TEXT_PAD) * s + "px";
      ta.style.width = (mw ? mw : Math.max(140, L.width + d.size)) * s + "px"; ta.style.height = Math.max(L.lh, L.height + 2) * s + "px";
      if (mw && ta.scrollHeight > ta.clientHeight) ta.style.height = ta.scrollHeight + "px";
      ta.style.color = M.cssColor(d); ta.style.background = "rgba(255,255,255,0.85)"; ta.classList.remove("note");
    }
  }
  finishEdit() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null; this.editingItem = null;
    const text = this.ta.value;
    this.ta.hidden = true;
    if (ed.idx === null) {
      if (text.trim()) {
        const d = { ...ed.proto, text, ...(ed.fmt || {}) };
        if (d.t === "note") d.h = Math.round(Math.max(d.h, R.noteNeededHeight(d, text)) * 100) / 100;
        this.commit([...this.items, d]);
      } else this.render();
      return;
    }
    const old = this.items[ed.idx];
    if (!old) { this.render(); return; }
    const items = this.items.slice();
    if (old.t === "text" && !text.trim()) { items.splice(ed.idx, 1); this.commit(items); return; }
    const fmtChanged = !!ed.fmt && (ed.fmt.dir !== old.dir || ed.fmt.align !== old.align);
    if (text !== old.text || fmtChanged) {
      const d = { ...old, text, ...(ed.fmt || {}) };
      if (old.t === "note") d.h = Math.round(Math.max(old.h, R.noteNeededHeight(d, text)) * 100) / 100;
      items[ed.idx] = d; this.commit(items, { keepSel: true });
    } else this.render();
  }

  // ----------------------------------------------------------- insert content
  async insertImageBlob(blob) {
    if (!this.hasPage) { toast("Open a PDF first."); return false; }
    this.finishEdit();
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch { toast("Could not read this image."); return false; }
    const s0 = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * s0)); c.height = Math.max(1, Math.round(bmp.height * s0));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const png = await new Promise((r) => c.toBlob(r, "image/png"));
    const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(png); });
    this.activateAt(this.ch / 2);
    const [pw, ph] = this.pageDims();
    let w = c.width * 0.75, h = c.height * 0.75;
    const fit = Math.min(1, 0.6 * pw / w, 0.6 * ph / h);
    w *= fit; h *= fit;
    const ctr = this.screenToPage(this.cw / 2, this.ch / 2);
    const x = clamp(ctr.x - w / 2, 0, Math.max(0, pw - w)), y = clamp(ctr.y - h / 2, 0, Math.max(0, ph - h));
    const r2 = (v) => Math.round(v * 100) / 100;
    const item = { t: "image", x1: r2(x), y1: r2(y), x2: r2(x + w), y2: r2(y + h), data };
    await R.getImage(data).promise;
    this.setTool("select");
    this.commit([...this.items, item], { select: this.items.length });
    this.syncStyleToSelection();
    return true;
  }
  insertText(text) {
    if (!this.hasPage || !text || !text.trim()) return false;
    this.finishEdit();
    this.activateAt(this.ch / 2);
    const [pw, ph] = this.pageDims(), ctr = this.screenToPage(this.cw / 2, this.ch / 2), st = this.curStyle;
    const bw = Math.min(M.TEXT_BOX_W, pw - 8), f = this.fmt;
    const item = { t: "text", x: clamp(ctr.x - bw / 2, 4, pw - bw - 4), y: clamp(ctr.y, 0, ph - 30), w: bw, dir: f.dir, align: f.align, text, color: st.color, size: st.size, ...this.styleExtra() };
    this.setTool("select");
    this.commit([...this.items, item], { select: this.items.length });
    return true;
  }
  async onImageFile() {
    const f = this.imgInput.files[0]; this.imgInput.value = "";
    if (f) await this.insertImageBlob(f);
  }

  // ----------------------------------------------------------------- pages
  async goto(n) {
    if (!this.hasPage || !this.offs) return;
    n = clamp(Math.round(n) || 0, 0, this.pages.length - 1);
    this.finishEdit();
    try { await this.loadSizes(n - 5, n + 20); } catch { /* sizes fall back to page 1's size */ }
    if (this.hasPage) this.scrollToPage(n);
  }
  showPage(n) { return this.showDoc(n); }
  /** First display of a document: read the first page sizes (PDF), lay out all pages, show page n at 'fit width'. */
  async showDoc(n) {
    const token = ++this.pageToken, doc = this.pdf && this.pdf.doc;
    this.selected = null; this.live = null; this.preview = null; this.action = null;
    if (this.kind === "pdf") {
      try { await this.loadSizes(n - 5, n + 20); } catch (e) { console.error(e); toast("Could not read this page."); return; }
      if (token !== this.pageToken || !this.pdf || this.pdf.doc !== doc) return;
      if (!this.sizes.some(Boolean)) this.sizes[0] = [595, 842];
    }
    this.layout();
    this.cur = this.vp = clamp(n, 0, this.pages.length - 1);
    this.view.fit = true; this.fitView(false);
    this.scrollToPage(this.cur);
    this.ui();
  }

  // --------------------------------------------------------------- PDF panel
  async openPdfBytes(bytes, name, { workspace = null } = {}) {
    let loaded;
    try { loaded = await PDF.loadDocument(bytes, { detectEmbedded: !workspace }); } catch (e) { toast(e.message || "Could not open the PDF."); return false; }
    const { doc, source } = loaded;
    let pages = workspace ? workspace.pages : loaded.pages;
    if (workspace && pages.length !== doc.numPages) { await doc.destroy(); toast("The PDF annotations do not match the embedded PDF."); return false; }
    this.finishEdit();
    this.resetDoc();
    if (this.pdf) { try { await this.pdf.doc.destroy(); } catch { /* ignore */ } }
    this.pdf = { doc, source }; this.name = name;
    this.pages = (pages || Array.from({ length: doc.numPages }, () => [])).map((items) => ({ items: items.slice() }));
    this.history.clear(); this.dirty = false; this.cur = 0;
    await this.showPage(0);
    this.app.onChange(this, { clean: true });
    return true;
  }
  clearPdf() {
    this.finishEdit(); this.resetDoc();
    if (this.pdf) this.pdf.doc.destroy().catch(() => {});
    this.pdf = null; this.name = null; this.pages = []; this.cur = 0;
    this.history.clear(); this.dirty = false; this.selected = null;
    this.ui(); this.render();
  }
  async saveAnnotated() {
    if (!this.pdf) { toast("Open a PDF first."); return false; }
    this.finishEdit();
    const busy = this.app.busy("Saving PDF…");
    try {
      const bytes = await PDF.exportAnnotatedPdf(this.pdf.source, this.pages.map((p) => p.items), (f) => busy.set(f));
      const base = (this.name || "document.pdf").replace(/\.pdf$/i, "");
      await this.app.saveBlob(new Blob([bytes], { type: "application/pdf" }), `${base}_annotated.pdf`);
      this.dirty = false; this.app.onChange(this, { clean: true }); this.ui();
      return true;
    } catch (e) { console.error(e); toast("Could not save the PDF: " + (e.message || e), 5000); return false; }
    finally { busy.done(); }
  }
  workspaceData() {
    if (!this.pdf) return null;
    this.finishEdit();
    return { name: this.name || "document.pdf", source: this.pdf.source, pages: this.pages.map((p) => p.items) };
  }

  // ------------------------------------------------------------ notebook panel
  async newNotebook() {
    if (!(await this.app.confirmReplace(this, "start a new notebook"))) return;
    this.setNotebook([{ paper: "lined", items: [] }], null);
  }
  setNotebook(pages, name) {
    this.finishEdit();
    this.pages = pages.map((p) => ({ paper: p.paper, items: p.items.slice() }));
    this.name = name; this.history.clear(); this.dirty = false; this.cur = 0;
    this.showPage(0);
    this.app.onChange(this, { clean: true });
  }
  /** Page-structure change (add / delete / move / paper). Applies to the page being viewed; the page column is laid out again. */
  structural(mutate, { scroll = true } = {}) {
    this.finishEdit();
    if (this.vp !== this.cur) this.setCur(this.vp);
    this.history.push(this.snap(), this.cur);
    mutate();
    this.selected = null; this.live = null; this.preview = null;
    this.dirty = true; this.app.onChange(this);
    this.layout();
    if (scroll) this.scrollToPage(this.cur); else { this.clampView(); this.ui(); this.render(); }
  }
  addPage() { this.structural(() => { this.pages.splice(this.cur + 1, 0, { paper: this.pages[this.cur].paper, items: [] }); this.cur++; }); }   // new page goes directly below the current one
  async deletePage() {
    if (this.pages.length <= 1) { toast("A notebook needs at least one page."); return; }
    if (this.vp !== this.cur) this.setCur(this.vp);
    if (this.items.length) {
      const ok = await dialog({ title: "Delete page", content: `Delete page ${this.cur + 1} and everything on it? (You can undo this.)`,
        buttons: [{ label: "Cancel", value: false }, { label: "Delete", value: true, primary: true, danger: true }] });
      if (!ok) return;
    }
    this.structural(() => { this.pages.splice(this.cur, 1); this.cur = Math.min(this.cur, this.pages.length - 1); });
  }
  movePage(step) {
    if (this.vp !== this.cur) this.setCur(this.vp);
    const j = this.cur + step;
    if (j < 0 || j >= this.pages.length) return;
    this.structural(() => { [this.pages[this.cur], this.pages[j]] = [this.pages[j], this.pages[this.cur]]; this.cur = j; });
  }
  setPaper(kind) {
    if (this.vp !== this.cur) this.setCur(this.vp);
    if (kind !== this.pages[this.cur].paper) this.structural(() => { this.pages[this.cur].paper = kind; }, { scroll: false });
  }
  async saveNotebook() {
    this.finishEdit();
    const base = (this.name || "notebook").replace(/\.dnote$/i, "");
    await this.app.saveBlob(new Blob([M.notebookToJson(this.pages)], { type: "application/json" }), `${base}.dnote`);
    this.dirty = false; this.app.onChange(this, { clean: true }); this.ui();
    return true;
  }
  async exportNotebook() {
    this.finishEdit();
    const busy = this.app.busy("Exporting PDF…");
    try {
      const bytes = await PDF.exportNotebookPdf(this.pages, (f) => busy.set(f));
      await this.app.saveBlob(new Blob([bytes], { type: "application/pdf" }), `${(this.name || "notebook").replace(/\.dnote$/i, "")}.pdf`);
    } catch (e) { console.error(e); toast("Could not export the PDF: " + (e.message || e), 5000); }
    finally { busy.done(); }
  }

  // ----------------------------------------------------------- files / misc
  pickFile(accept) { this.fileInput.accept = accept; this.fileInput.click(); }
  async onFile() {
    const f = this.fileInput.files[0]; this.fileInput.value = "";
    if (!f) return;
    if (!(await this.app.confirmReplace(this, "open another file"))) return;
    if (this.kind === "pdf") await this.openPdfBytes(new Uint8Array(await f.arrayBuffer()), f.name);
    else {
      try { this.setNotebook(M.parseNotebook(await f.text()), f.name); } catch (e) { toast(e.message, 4000); }
    }
  }
  viewState() { return { zoom: Math.round(this.view.scale * 1e4) / 1e4, auto_fit: this.view.fit, page: this.shown(), bars: this.barsOpen,
    toolbar: { tool: this.tool, groups: JSON.parse(JSON.stringify(this.groups)), recent: [...this.recent], text_format: { ...this.fmt }, shape: this.shapeKind, fill: this.fillOn } }; }
  restoreView(st) {
    if (!st || typeof st !== "object") return;
    const tb = st.toolbar;
    if (tb && typeof tb === "object") {
      if (tb.groups && typeof tb.groups === "object") for (const k of Object.keys(this.groups)) this.groups[k] = M.sanitizeStyle(tb.groups[k], this.groups[k]);
      if (Array.isArray(tb.recent)) this.recent = tb.recent.map((c) => { const p = typeof c === "string" ? M.parseHex(c) : null; return p ? M.toHex(...p) : null; }).filter(Boolean).slice(0, 10);
      const tf = tb.text_format;
      if (tf && typeof tf === "object") this.fmt = { dir: M.TEXT_DIRS.includes(tf.dir) ? tf.dir : this.fmt.dir, align: M.TEXT_ALIGNS.includes(tf.align) ? tf.align : this.fmt.align };
      if (typeof tb.shape === "string" && M.SHAPE_KINDS.some((k) => k.id === tb.shape)) this.shapeKind = tb.shape;
      if (typeof tb.fill === "boolean") this.fillOn = tb.fill;
      let tool = tb.tool;
      if (OLD_SHAPE_TOOLS.includes(tool)) { this.shapeKind = tool; tool = "shape"; }   // workspaces from before the Shapes tool
      this.updateShapeBtn();
      const allowed = this.kind === "pdf" ? PDF_TOOLS : NB_TOOLS;
      this.setTool(allowed.includes(tool) ? tool : this.tool);
    }
    if (typeof st.bars === "boolean") this.setBars(st.bars);
    if (st.auto_fit === false && Number.isFinite(+st.zoom) && this.hasPage) {
      const [w] = this.pageDims();
      this.view.scale = clamp(+st.zoom, 0.2, 6); this.view.fit = false;
      if (this.continuous() && this.offs) { this.view.tx = (this.cw - this.docW * this.view.scale) / 2; this.scrollToPage(this.vp); }
      else { this.view.tx = (this.cw - w * this.view.scale) / 2; this.view.ty = 8; this.clampView(); this.scheduleRaster(); }
    } else if (this.hasPage) this.fitView(false);
    this.render();
  }
  setLabel(label) { this.label = label; this.ui(); }

  ui() {
    const n = this.pages.length, has = this.hasPage;
    const name = this.name || (this.kind === "pdf" ? "no file" : "untitled");
    this.titleEl.replaceChildren(el("b", {}, this.label), " — " + name, this.dirty ? el("span", { class: "dirty" }, " •") : "");
    this.root.classList.toggle("dirty", this.dirty);
    this.msg.replaceChildren();
    if (!has) {
      this.msg.append(el("div", { class: "hint" }, el("p", {}, "Open a PDF to begin"),
        el("button", { class: "btn primary big", type: "button", onclick: () => this.pickFile(".pdf,application/pdf") }, icon("open"), "Open PDF"),
        el("p", { class: "muted" }, "or drop a .pdf file here")));
    }
    this.pageInput.value = has ? this.shown() + 1 : ""; this.pageInput.max = n; this.pageCount.textContent = has ? ` / ${n}` : " / 0";
    const set = (b, on) => { b.disabled = !on; };
    set(this.b.undo, this.history.canUndo()); set(this.b.redo, this.history.canRedo());
    set(this.b.prev, has && this.shown() > 0); set(this.b.next, has && this.shown() < n - 1);
    set(this.b.zin, has); set(this.b.zout, has); set(this.b.fit, has); this.pageInput.disabled = !has;
    set(this.b.image, has);
    if (this.kind === "pdf") set(this.b.save, has);
    else {
      set(this.b.del, n > 1); set(this.b.earlier, this.shown() > 0); set(this.b.later, this.shown() < n - 1);
      this.paper.value = this.pages[this.shown()]?.paper || "lined";
    }
    if (this.toolBtns.hltext) this.toolBtns.hltext.disabled = !has;
  }
}
