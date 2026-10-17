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
  line: ["Line", "Draw a line"], arrow: ["Arrow", "Draw an arrow"], rect: ["Rect", "Draw a rectangle"], ellipse: ["Circle", "Draw an ellipse"],
  pan: ["Hand", "Drag to scroll"],
};
const PDF_TOOLS = ["select", "pen", "mark", "hltext", "eraser", "text", "note", "line", "arrow", "rect", "ellipse", "pan"];
const NB_TOOLS = ["select", "pen", "mark", "eraser", "text", "note", "line", "arrow", "rect", "ellipse", "pan"];
const GROUP_OF_TOOL = { pen: "draw", text: "draw", line: "draw", arrow: "draw", rect: "draw", ellipse: "draw", mark: "mark", hltext: "hltext", note: "note" };
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
    this.pdf = null; this.sizes = []; this.words = null; this.raster = null; this.rasterJob = null; this.rasterTimer = 0; this.pageToken = 0;
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
  pageDims() { return this.kind === "nb" ? [M.PAGE_W, M.PAGE_H] : (this.sizes[this.cur] || [595, 842]); }
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
      const x = el("button", { class: "btn tool", type: "button", title: TOOL_INFO[k][1], "aria-label": TOOL_INFO[k][0],
        "aria-pressed": "false", onclick: () => this.setTool(k) }, icon(k), el("span", { class: "lbl" }, TOOL_INFO[k][0]));
      this.toolBtns[k] = x; toolBar.append(x);
    }
    this.colorBtn = el("button", { class: "btn", type: "button", title: "Choose a colour", onclick: () => this.openColor() },
      el("span", { class: "cdot" }), el("span", { class: "lbl" }, "Color"), icon("chevdown", "tiny"));
    this.brushBtn = el("button", { class: "btn", type: "button", title: "Thickness, opacity, brightness, text size", onclick: () => this.openBrush() },
      icon("brush"), el("span", { class: "lbl" }, "Brush"), icon("chevdown", "tiny"));
    toolBar.append(el("span", { class: "gap" }), this.colorBtn, this.brushBtn);

    this.bars = el("div", { class: "bars" }, fileBar, pageBar, toolBar);

    this.canvas = el("canvas", { class: "view", "aria-label": this.label });
    this.ctx = this.canvas.getContext("2d");
    this.ta = el("textarea", { class: "editor", hidden: true, rows: 1, dir: "auto", spellcheck: false, autocapitalize: "off",
      oninput: () => this.positionEditor(), onblur: () => this.finishEdit(),
      onkeydown: (e) => { if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.finishEdit(); } e.stopPropagation(); } });
    this.msg = el("div", { class: "msg" });
    this.stage = el("div", { class: "stage", tabIndex: -1 }, this.canvas, this.ta, this.msg);
    this.root = el("section", { class: "panel", dataset: { key: this.key, kind: this.kind } }, head, this.bars, this.stage, this.fileInput, this.imgInput);

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
    this.barsBtn.textContent = open ? "Toolbars ▾" : "Toolbars ▸";
    this.onResize();
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
    const [w] = this.pageDims();
    const margin = this.cw < 500 ? 6 : 14;
    this.view.scale = clamp((this.cw - 2 * margin) / w, 0.2, 6);
    this.view.fit = true;
    this.view.tx = (this.cw - w * this.view.scale) / 2;
    this.view.ty = margin;
    if (userAction) { this.render(); this.scheduleRaster(); }
  }
  clampView() {
    const [w, h] = this.pageDims(), s = this.view.scale, pw = w * s, ph = h * s, m = 80;
    this.view.tx = pw <= this.cw ? (this.cw - pw) / 2 : clamp(this.view.tx, this.cw - pw - m, m);
    this.view.ty = ph <= this.ch - 16 ? clamp(this.view.ty, 8, this.ch - ph - 8) : clamp(this.view.ty, this.ch - ph - m, m);
  }
  zoomAt(factor, cx, cy) {
    const old = this.view.scale, s = clamp(old * factor, 0.2, 6), k = s / old;
    this.view.tx = cx - (cx - this.view.tx) * k; this.view.ty = cy - (cy - this.view.ty) * k;
    this.view.scale = s; this.view.fit = false;
    this.clampView(); this.positionEditor(); this.render(); this.scheduleRaster();
  }
  zoomBy(f) { this.zoomAt(f, this.cw / 2, this.ch / 2); }
  toPage(e) {
    const r = this.stage.getBoundingClientRect();
    return this.screenToPage(e.clientX - r.left, e.clientY - r.top);
  }
  screenToPage(sx, sy) { return { x: (sx - this.view.tx) / this.view.scale, y: (sy - this.view.ty) / this.view.scale }; }
  clampP(p) { const [w, h] = this.pageDims(); return { x: clamp(p.x, 0, w), y: clamp(p.y, 0, h) }; }

  // ------------------------------------------------------------- PDF raster
  scheduleRaster() {
    if (this.kind !== "pdf" || !this.pdf) return;
    clearTimeout(this.rasterTimer);
    this.rasterTimer = setTimeout(() => this.ensureRaster(), 120);
  }
  async ensureRaster() {
    if (this.kind !== "pdf" || !this.pdf) return;
    const [w, h] = this.pageDims();
    let want = clamp(this.view.scale * this.dpr, 0.5, 6);
    while (w * want * h * want > 14e6 && want > 0.5) want *= 0.9;
    const r = this.raster;
    if (r && r.doc === this.pdf.doc && r.page === this.cur && r.scale >= want * 0.9 && r.scale <= want * 2.5) return;
    this.rasterJob?.cancel();
    const doc = this.pdf.doc, page = this.cur;
    const job = this.rasterJob = PDF.renderRaster(doc, page, want);
    try {
      const canvas = await job.promise;
      if (canvas && this.rasterJob === job && this.pdf && this.pdf.doc === doc && this.cur === page) {
        this.raster = { doc, page, scale: want, canvas }; this.render();
      }
    } catch (e) { console.error(e); }
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
    this.msg.hidden = this.hasPage;
    if (!this.hasPage) return;
    const [w, h] = this.pageDims(), v = this.view;
    ctx.save();
    ctx.translate(v.tx, v.ty); ctx.scale(v.scale, v.scale);
    ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 8 / v.scale; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.shadowColor = "transparent";
    if (this.kind === "nb") R.drawPaper(ctx, w, h, this.pages[this.cur].paper);
    else if (this.raster && this.raster.doc === this.pdf.doc && this.raster.page === this.cur) { ctx.imageSmoothingQuality = "high"; ctx.drawImage(this.raster.canvas, 0, 0, w, h); }
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    const list = this.drawList;
    for (let i = 0; i < list.length; i++) R.drawItem(ctx, list[i], { skipText: !!this.editing && this.editing.idx === i });
    if (this.preview) for (const p of [].concat(this.preview)) R.drawItem(ctx, p);
    ctx.restore();
    if (this.selected !== null && list[this.selected]) this.drawSelection(ctx, list[this.selected]);
    ctx.restore();
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
      ctx.beginPath(); ctx.arc(v.tx + x * v.scale, v.ty + y * v.scale, HANDLE_R, 0, Math.PI * 2);
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
      const d = Math.hypot(v.tx + x * v.scale - sx, v.ty + y * v.scale - sy);
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
    if (idx !== this.cur) await this.showPage(idx); else this.render();
    this.app.onChange(this); this.ui();
  }

  // ----------------------------------------------------------------- pointers
  styleExtra() { return { alpha: this.curStyle.alpha, bright: this.curStyle.bright }; }
  onWheel(e) {
    e.preventDefault();
    if (!this.hasPage) return;
    const r = this.stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) { this.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top); return; }
    this.view.tx -= e.shiftKey ? e.deltaY : e.deltaX; this.view.ty -= e.shiftKey ? 0 : e.deltaY;
    this.view.fit = this.view.fit && false; this.clampView(); this.positionEditor(); this.render(); this.scheduleRaster();
  }
  local(e) { const r = this.stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  onDown(e) {
    if (!this.hasPage || e.button > 0) return;
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
    if (["line", "arrow", "rect", "ellipse", "hltext"].includes(t)) { this.action = { type: "shape", p0: this.clampP(p), l0: l, moved: false }; return; }
    if (t === "eraser") { this.live = this.items.slice(); this.action = { type: "erase" }; this.eraseAt(p); return; }
    if (t === "text" || t === "note") { this.action = { type: "tap", p, l0: l, moved: false }; return; }
  }
  toolMove(e, l, evs) {
    const a = this.action;
    if (a.type === "palm" || a.type === "none") return;
    if (a.type === "pan") {
      this.view.tx += l.x - a.last.x; this.view.ty += l.y - a.last.y; a.last = l; this.view.fit = false;
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
    if (a.type === "pan") { if (a.tap) this.tapSelect(null, l); return; }
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
      const proto = { t: "text", x: clamp(p.x, 0, w - 10), y: clamp(p.y - st.size * 0.7, 0, h - 10), text: "", color: st.color, size: st.size, ...this.styleExtra() };
      this.startEdit(null, proto);
    } else {
      const proto = { t: "note", x: clamp(p.x, 0, w - M.NOTE_W), y: clamp(p.y, 0, h - M.NOTE_H), w: M.NOTE_W, h: M.NOTE_H, text: "", color: st.color, size: st.size, ...this.styleExtra() };
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
    let x2 = b.x, y2 = b.y;
    if (shift && (this.tool === "rect" || this.tool === "ellipse")) {
      const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      x2 = a.x + (b.x >= a.x ? s : -s); y2 = a.y + (b.y >= a.y ? s : -s);
    }
    const r2 = (v) => Math.round(v * 100) / 100;
    return [{ t: this.tool, x1: r2(a.x), y1: r2(a.y), x2: r2(x2), y2: r2(y2), color: st.color, w: st.width, ...this.styleExtra() }];
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

  // --------------------------------------------------------------- text edit
  startEdit(idx, proto = null) {
    this.finishEdit();
    const d = idx !== null ? this.items[idx] : proto;
    this.editing = { idx, proto };
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
    ta.style.fontSize = d.size * s + "px"; ta.style.lineHeight = "1.25"; ta.style.fontFamily = R.FONT_STACK;
    if (d.t === "note") {
      ta.style.left = v.tx + (d.x + 8) * s + "px"; ta.style.top = v.ty + (d.y + M.NOTE_HEADER + 4) * s + "px";
      ta.style.width = R.noteTextWidth(d) * s + "px"; ta.style.height = Math.max(40, (d.h - M.NOTE_HEADER - 8)) * s + "px";
      ta.style.color = M.noteTextColor({ color: d.color, bright: M.itemBright(d) }); ta.style.background = "transparent"; ta.classList.add("note");
    } else {
      const L = R.layoutText(R.measureCtx(), ta.value || " ", d.size);
      ta.style.left = v.tx + (d.x + R.TEXT_PAD) * s + "px"; ta.style.top = v.ty + (d.y + R.TEXT_PAD) * s + "px";
      ta.style.width = Math.max(140, (L.width + d.size) * s) + "px"; ta.style.height = Math.max(L.lh, L.height + 2) * s + "px";
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
        const d = { ...ed.proto, text };
        if (d.t === "note") d.h = Math.round(Math.max(d.h, R.noteNeededHeight(d, text)) * 100) / 100;
        this.commit([...this.items, d]);
      } else this.render();
      return;
    }
    const old = this.items[ed.idx];
    if (!old) { this.render(); return; }
    const items = this.items.slice();
    if (old.t === "text" && !text.trim()) { items.splice(ed.idx, 1); this.commit(items); return; }
    if (text !== old.text) {
      const d = { ...old, text };
      if (old.t === "note") d.h = Math.round(Math.max(old.h, R.noteNeededHeight(old, text)) * 100) / 100;
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
    const [pw, ph] = this.pageDims(), ctr = this.screenToPage(this.cw / 2, this.ch / 2), st = this.curStyle;
    const item = { t: "text", x: clamp(ctr.x - 60, 0, pw - 40), y: clamp(ctr.y, 0, ph - 30), text, color: st.color, size: st.size, ...this.styleExtra() };
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
    if (!this.hasPage) return;
    n = clamp(Math.round(n) || 0, 0, this.pages.length - 1);
    this.finishEdit();
    if (n !== this.cur) await this.showPage(n); else this.ui();
  }
  async showPage(n) {
    const token = ++this.pageToken;
    this.cur = n; this.selected = null; this.live = null; this.preview = null; this.action = null;
    if (this.kind === "pdf") {
      if (!this.sizes[n]) {
        try { this.sizes[n] = await PDF.pageSize(this.pdf.doc, n); } catch (e) { console.error(e); toast("Could not read this page."); return; }
        if (token !== this.pageToken) return;
      }
      this.words = null;
      PDF.pageWords(this.pdf.doc, n).then((w) => { if (token === this.pageToken) this.words = w; }).catch(() => {});
    }
    this.view.fit = true; this.fitView(false);
    this.raster = null; this.rasterJob?.cancel();
    this.ui(); this.render(); this.ensureRaster();
    await R.preloadImages(this.items);
    this.render();
  }

  // --------------------------------------------------------------- PDF panel
  async openPdfBytes(bytes, name, { workspace = null } = {}) {
    let loaded;
    try { loaded = await PDF.loadDocument(bytes, { detectEmbedded: !workspace }); } catch (e) { toast(e.message || "Could not open the PDF."); return false; }
    const { doc, source } = loaded;
    let pages = workspace ? workspace.pages : loaded.pages;
    if (workspace && pages.length !== doc.numPages) { await doc.destroy(); toast("The PDF annotations do not match the embedded PDF."); return false; }
    this.finishEdit();
    this.rasterJob?.cancel();
    if (this.pdf) { try { await this.pdf.doc.destroy(); } catch { /* ignore */ } }
    this.pdf = { doc, source }; this.name = name; this.sizes = []; this.raster = null;
    this.pages = (pages || Array.from({ length: doc.numPages }, () => [])).map((items) => ({ items: items.slice() }));
    this.history.clear(); this.dirty = false; this.cur = 0;
    await this.showPage(0);
    this.app.onChange(this, { clean: true });
    return true;
  }
  clearPdf() {
    this.finishEdit(); this.rasterJob?.cancel();
    if (this.pdf) this.pdf.doc.destroy().catch(() => {});
    this.pdf = null; this.name = null; this.pages = []; this.sizes = []; this.raster = null; this.cur = 0;
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
  structural(mutate) {
    this.finishEdit();
    this.history.push(this.snap(), this.cur);
    mutate();
    this.dirty = true; this.app.onChange(this);
    this.showPage(this.cur);
  }
  addPage() { this.structural(() => { this.pages.splice(this.cur + 1, 0, { paper: this.pages[this.cur].paper, items: [] }); this.cur++; }); }
  async deletePage() {
    if (this.pages.length <= 1) { toast("A notebook needs at least one page."); return; }
    if (this.items.length) {
      const ok = await dialog({ title: "Delete page", content: `Delete page ${this.cur + 1} and everything on it? (You can undo this.)`,
        buttons: [{ label: "Cancel", value: false }, { label: "Delete", value: true, primary: true, danger: true }] });
      if (!ok) return;
    }
    this.structural(() => { this.pages.splice(this.cur, 1); this.cur = Math.min(this.cur, this.pages.length - 1); });
  }
  movePage(step) {
    const j = this.cur + step;
    if (j < 0 || j >= this.pages.length) return;
    this.structural(() => { [this.pages[this.cur], this.pages[j]] = [this.pages[j], this.pages[this.cur]]; this.cur = j; });
  }
  setPaper(kind) { if (kind !== this.pages[this.cur].paper) this.structural(() => { this.pages[this.cur].paper = kind; }); }
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
  viewState() { return { zoom: Math.round(this.view.scale * 1e4) / 1e4, auto_fit: this.view.fit, page: this.cur, bars: this.barsOpen,
    toolbar: { tool: this.tool, groups: JSON.parse(JSON.stringify(this.groups)), recent: [...this.recent] } }; }
  restoreView(st) {
    if (!st || typeof st !== "object") return;
    const tb = st.toolbar;
    if (tb && typeof tb === "object") {
      if (tb.groups && typeof tb.groups === "object") for (const k of Object.keys(this.groups)) this.groups[k] = M.sanitizeStyle(tb.groups[k], this.groups[k]);
      if (Array.isArray(tb.recent)) this.recent = tb.recent.map((c) => { const p = typeof c === "string" ? M.parseHex(c) : null; return p ? M.toHex(...p) : null; }).filter(Boolean).slice(0, 10);
      const allowed = this.kind === "pdf" ? PDF_TOOLS : NB_TOOLS;
      this.setTool(allowed.includes(tb.tool) ? tb.tool : this.tool);
    }
    if (typeof st.bars === "boolean") this.setBars(st.bars);
    if (st.auto_fit === false && Number.isFinite(+st.zoom) && this.hasPage) {
      const [w] = this.pageDims();
      this.view.scale = clamp(+st.zoom, 0.2, 6); this.view.fit = false;
      this.view.tx = (this.cw - w * this.view.scale) / 2; this.view.ty = 8;
      this.clampView(); this.scheduleRaster();
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
    this.pageInput.value = has ? this.cur + 1 : ""; this.pageInput.max = n; this.pageCount.textContent = has ? ` / ${n}` : " / 0";
    const set = (b, on) => { b.disabled = !on; };
    set(this.b.undo, this.history.canUndo()); set(this.b.redo, this.history.canRedo());
    set(this.b.prev, has && this.cur > 0); set(this.b.next, has && this.cur < n - 1);
    set(this.b.zin, has); set(this.b.zout, has); set(this.b.fit, has); this.pageInput.disabled = !has;
    set(this.b.image, has);
    if (this.kind === "pdf") set(this.b.save, has);
    else {
      set(this.b.del, n > 1); set(this.b.earlier, this.cur > 0); set(this.b.later, this.cur < n - 1);
      this.paper.value = this.pages[this.cur]?.paper || "lined";
    }
    if (this.toolBtns.hltext) this.toolBtns.hltext.disabled = !has;
  }
}
