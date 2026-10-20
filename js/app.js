// DualNote (web / Android): application shell - layout, workspace files, autosave, dialogs, shortcuts.
import * as M from "./model.js";
import * as K from "./keys.js";
import * as WS from "./workspace.js";
import { Panel } from "./panel.js";
import { setImageLoadedCallback } from "./render.js";
import { el, icon, toast, dialog, popup, closePopup } from "./ui.js";

const PER_PANEL = 430;                               // a workspace with n panels needs n * 430 px, below that one panel is shown at a time (tabs)
const PANEL_NAMES = { pdf: "PDF", pdf2: "PDF 2", nb: "Notebook", nb2: "Notebook 2", board: "Board", board2: "Board 2" };
// The Layout menu chooses the workspace type, i.e. which panels the workspace consists of (not just what is visible).
const LAYOUTS = [["PDF Only", ["pdf"]], ["Notebook Only", ["nb"]], ["Board Only", ["board"]], ["PDF + Notebook", ["pdf", "nb"]], ["Notebook + PDF", ["nb", "pdf"]],
  ["PDF + Board", ["pdf", "board"]], ["Notebook + Board", ["nb", "board"]], ["PDF + Notebook + Board", ["pdf", "nb", "board"]]];

// ------------------------------------------------------------- IndexedDB
const idb = {
  db: null,
  open() {
    if (this.db) return this.db;
    return (this.db = new Promise((res, rej) => {
      const r = indexedDB.open("dualnote", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => { const t = db.transaction("kv", mode), s = t.objectStore("kv"); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  },
  get(k) { return this.tx("readonly", (s) => s.get(k)); },
  set(k, v) { return this.tx("readwrite", (s) => s.put(v, k)); },
  del(k) { return this.tx("readwrite", (s) => s.delete(k)); },
  keys() { return this.tx("readonly", (s) => s.getAllKeys()); },
};

export class App {
  constructor(root) {
    this.root = root;
    this.order = [...M.DEFAULT_LAYOUT]; this.viewMode = "both"; this.tab = 0; this.active = null;
    this.panels = { pdf: new Panel(this, "pdf", "pdf", "PDF"), pdf2: new Panel(this, "pdf2", "pdf", "PDF 2"),
      nb: new Panel(this, "nb", "nb", "Notebook"), nb2: new Panel(this, "nb2", "nb", "Notebook 2"),
      board: new Panel(this, "board", "board", "Board"), board2: new Panel(this, "board2", "board", "Board 2") };
    this.autosaveOk = true; this.autosaveTimer = 0; this.wsName = null; this.installEvt = null;
    setImageLoadedCallback(() => { for (const p of Object.values(this.panels)) p.render(); });
    // the bundled Persian font is used by the canvas too: redraw once it has loaded
    document.fonts?.load?.('16px Vazirmatn', "\u067e\u0686\u0698\u06af").then(() => { for (const p of Object.values(this.panels)) p.render(); }).catch(() => {});   // pictures that finish decoding appear at once
    this.buildDom();
    this.refreshLayout();
    window.addEventListener("resize", () => this.refreshLayout());
    window.addEventListener("beforeunload", (e) => { this.flushAutosave(); if (this.anyDirty() && !this.autosaveOk) { e.preventDefault(); e.returnValue = ""; } });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") this.flushAutosave(); });
    window.addEventListener("pagehide", () => this.flushAutosave());
    document.addEventListener("keydown", (e) => this.onKey(e));
    document.addEventListener("keyup", (e) => { if (K.keyName(e) === " ") this.endTempHand(); });          // releasing Space returns to the previous tool
    window.addEventListener("blur", () => this.endTempHand());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.endTempHand(); });
    document.addEventListener("paste", (e) => this.onPaste(e));
    document.addEventListener("dragover", (e) => { e.preventDefault(); });
    document.addEventListener("drop", (e) => this.onDrop(e));
    window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); this.installEvt = e; this.installBtn.hidden = false; });
    this.setActive(this.panels.pdf);
  }

  // --------------------------------------------------------------------- DOM
  buildDom() {
    const b = (ic, label, title, fn, cls = "") => el("button", { class: "btn " + cls, type: "button", title, "aria-label": title, onclick: fn }, icon(ic), el("span", { class: "lbl" }, label));
    this.wsOpenInput = el("input", { type: "file", accept: ".dnws,application/zip", hidden: true, onchange: () => this.onWorkspaceFile() });
    this.layoutBtn = b("layout", "Layout", "Choose the workspace layout (which panels it has)", () => this.openLayoutMenu());
    this.switchBtn = b("swap", "Switch", "Swap the left and right panels (nothing is closed or lost)", () => this.switchSides());
    this.seg = el("div", { class: "seg", role: "tablist" });
    this.installBtn = b("plus", "Install", "Install DualNote as an app", async () => { if (this.installEvt) { this.installEvt.prompt(); this.installEvt = null; this.installBtn.hidden = true; } }, "primary");
    this.installBtn.hidden = true;
    this.top = el("header", { class: "topbar" },
      el("span", { class: "brand" }, "DualNote"),
      b("open", "Open workspace", "Open a workspace file (.dnws)", () => this.wsOpenInput.click()),
      b("save", "Save workspace", "Save everything (PDF, annotations, notebooks) in one file (" + K.MOD + "+S)", () => this.saveWorkspace()),
      b("plus", "New", "Start a new empty workspace", () => this.newWorkspace()),
      el("span", { class: "gap" }), this.layoutBtn, this.switchBtn, this.seg, this.installBtn,
      b("menu", "", "Help", () => this.help(), "icon-only"), this.wsOpenInput);
    this.main = el("main", { class: "main" });
    for (const k of Object.keys(this.panels)) this.main.append(this.panels[k].root);
    this.busyBox = el("div", { class: "busy", hidden: true }, el("div", { class: "busybox" }, el("div", { class: "spin" }), el("div", { class: "busymsg" }), el("div", { class: "bar2" }, el("div", { class: "fill" }))));
    this.root.append(this.top, this.main, this.busyBox);
  }
  name(key) {                                         // "PDF 1" / "PDF 2" when both instances are in the workspace
    const base = PANEL_NAMES[key], twin = key.endsWith("2") ? null : key + "2";
    return twin && this.order.includes(twin) ? base + " 1" : base;
  }
  get narrow() { const n = this.order.length; return n >= 2 && window.innerWidth < PER_PANEL * n; }
  /** Wide screens show every panel of the workspace. On a narrow screen (phone) a multi-panel workspace shows one panel at a time (tabs). */
  shownKeys() { const o = this.order; return o.length < 2 || !this.narrow ? o : [o[Math.min(this.tab, o.length - 1)]]; }
  refreshLayout() {
    const n = this.order.length, shown = this.shownKeys();
    for (const [k, p] of Object.entries(this.panels)) {
      p.root.hidden = !shown.includes(k); p.root.style.order = String(this.order.indexOf(k) < 0 ? 9 : this.order.indexOf(k));
      p.setLabel(this.name(k));
    }
    this.root.dataset.narrow = String(this.narrow);
    this.seg.replaceChildren();
    const tabs = n >= 2 && this.narrow ? this.order : [];
    this.seg.hidden = !tabs.length; this.switchBtn.hidden = n !== 2;
    const preset = LAYOUTS.find(([, o]) => o.join() === this.order.join());
    this.layoutBtn.title = `Layout: ${preset ? preset[0] : `custom (${n} panels)`} - choose which panels the workspace has`;
    tabs.forEach((k, i) => this.seg.append(el("button", { class: "segbtn" + (shown[0] === k ? " on" : ""), type: "button", role: "tab", "aria-selected": String(shown[0] === k),
      onclick: () => this.setTab(i) }, this.name(k))));
    for (const k of shown) this.panels[k].onResize();
    if (!shown.includes(this.active?.key)) this.setActive(this.panels[shown[0]]);
  }
  setTab(i) { this.tab = i; this.viewMode = i === 0 ? "left" : i === 1 ? "right" : "both"; this.refreshLayout(); this.scheduleAutosave(); }
  setView(mode) { this.setTab(mode === "right" ? 1 : 0); }          // (older name)
  setActive(p) { if (this.active === p) return; this.active = p; for (const q of Object.values(this.panels)) q.root.classList.toggle("active", q === p); }
  openLayoutMenu() {
    const row = (label, on, fn) => el("button", { class: "mi" + (on ? " on" : ""), type: "button", role: "menuitemradio", "aria-checked": String(on), onclick: fn },
      el("span", { class: "chk" }, on ? "✓" : ""), label);
    const custom = !LAYOUTS.some(([, o]) => o.join() === this.order.join());
    const box = el("div", { class: "menu", role: "menu" },
      ...LAYOUTS.map(([label, order]) => row(label, this.order.join() === order.join(), () => { closePopup(); this.setLayout(order); })),
      el("div", { class: "msep" }),
      row("Customize panels…", custom, () => { closePopup(); this.openArrange(); }));
    popup(this.layoutBtn, box);
  }
  /** Free arrangement: 1-3 panels, each one of the six (PDF, Notebook, Board and a second of each). Content stays with its panel. */
  async openArrange() {
    const rows = [...this.order], ALL = Object.keys(this.panels), prefer = ["pdf", "nb", "board", "pdf2", "nb2", "board2"];
    const box = el("div", { class: "arrange" });
    const draw = () => {
      box.replaceChildren(...rows.map((k, i) => {
        const sel = el("select", { "aria-label": `Panel ${i + 1}`, onchange: (e) => { rows[i] = e.target.value; draw(); } },
          ALL.filter((x) => x === k || !rows.includes(x)).map((x) => el("option", { value: x }, PANEL_NAMES[x])));
        sel.value = k;
        return el("div", { class: "arow" }, el("span", { class: "anum" }, String(i + 1)), sel,
          el("button", { class: "btn small", type: "button", title: "Move left", "aria-label": "Move left", disabled: i === 0, onclick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); } }, "←"),
          el("button", { class: "btn small", type: "button", title: "Move right", "aria-label": "Move right", disabled: i === rows.length - 1, onclick: () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; draw(); } }, "→"),
          el("button", { class: "btn small", type: "button", title: "Remove this panel from the workspace", "aria-label": "Remove panel", disabled: rows.length <= 1, onclick: () => { rows.splice(i, 1); draw(); } }, "✕"));
      }),
      rows.length < M.MAX_PANELS ? el("button", { class: "btn", type: "button", onclick: () => { rows.push(prefer.find((x) => !rows.includes(x))); draw(); } }, icon("plus"), "Add panel")
        : el("p", { class: "muted" }, `A workspace has up to ${M.MAX_PANELS} panels.`),
      el("p", { class: "muted" }, "Panels left out are not deleted: they keep their content in memory and come back when you add them again. Left to right = the order on screen."));
    };
    draw();
    const ok = await dialog({ title: "Arrange panels", content: box, buttons: [{ label: "Cancel", value: false }, { label: "Apply", value: true, primary: true }] });
    if (ok) await this.setLayout(rows);
  }
  switchSides() { this.setLayout([...this.order].reverse(), false); }
  /** Change the workspace structure (which panels it consists of, and in which order). Panels that leave the structure are asked about first. */
  async setLayout(order, ask = true) {
    order = M.sanitizeLayout(order);
    if (order.join() === this.order.join()) { this.refreshLayout(); return true; }
    if (ask) for (const key of M.hiddenByLayoutChange(this.order, order)) if (!(await this.confirmExclude(key))) return false;
    this.order = order; this.viewMode = "both"; this.tab = 0;
    this.refreshLayout(); this.scheduleAutosave();
    return true;
  }
  /** Does this panel hold something the user made / opened? */
  hasContent(p) { return p.kind === "pdf" ? p.hasPage : (p.dirty || !this.isPristine(p)); }
  /** A panel is about to leave the workspace structure. Its data is NOT deleted: it stays in memory (and in the session backup)
   *  and returns when a layout with that panel is chosen again - but it is not part of the workspace file any more. */
  async confirmExclude(key) {
    const p = this.panels[key];
    if (!this.hasContent(p)) return true;
    const what = { pdf: "PDF", nb: "notebook", board: "board" }[p.kind], unsaved = p.dirty;
    const choice = await dialog({ title: `Leave the ${what} out of this workspace?`,
      content: el("div", {}, el("p", {}, `The new layout has no ${what} panel, so “${this.name(key)}” will no longer be part of this workspace and will not be written to its file.`),
        unsaved ? el("p", {}, "It also has changes that are not saved yet.") : "",
        el("p", { class: "muted" }, `Nothing is deleted: it stays in memory for this session and comes back if you choose a layout with a ${what} again. To keep it permanently, save it separately first.`)),
      buttons: [{ label: "Cancel", value: "cancel" }, { label: `Save the ${what} separately first`, value: "save" }, { label: "Continue", value: "go", primary: true }] });
    if (!choice || choice === "cancel") return false;
    if (choice === "save") return !!(await p.saveSeparately());
    return true;
  }
  /** The panel of this kind in the current workspace; if there is none (e.g. a PDF is dropped into a Notebook-only workspace), the workspace becomes PDF + Notebook. */
  async ensurePanelOfKind(kind) {
    const have = this.order.map((k) => this.panels[k]).find((q) => q.kind === kind);
    if (have) return have;
    const key = kind, keep = this.order.slice(0, M.MAX_PANELS - 1);                // a PDF goes to the left, the others to the right
    const order = this.order.length < M.MAX_PANELS ? (kind === "pdf" ? [key, ...this.order] : [...this.order, key]) : (kind === "pdf" ? [key, ...keep] : [...keep, key]);
    if (!(await this.setLayout(order))) return null;
    return this.panels[key];
  }
  /** Before a panel's content is replaced by opening something else. */
  async confirmReplace(p, action) {
    if (!p.dirty) return true;
    const choice = await dialog({ title: "Unsaved changes", content: `“${p.name || p.label}” has unsaved changes. Save a copy before you ${action}?`,
      buttons: [{ label: "Cancel", value: "cancel" }, { label: "Don't save", value: "dont", danger: true }, { label: "Save", value: "save", primary: true }] });
    if (!choice || choice === "cancel") return false;
    if (choice === "save") return p.saveSeparately();
    return true;
  }
  anyDirty() { return Object.values(this.panels).some((p) => p.dirty); }

  // -------------------------------------------------------------- files
  async saveBlob(blob, filename) {
    const cap = globalThis.Capacitor;
    if (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins?.Filesystem) {            // Android app (Capacitor)
      const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
      const r = await cap.Plugins.Filesystem.writeFile({ path: filename, data, directory: "CACHE" });
      if (cap.Plugins.Share) await cap.Plugins.Share.share({ title: filename, url: r.uri, dialogTitle: "Save or share " + filename });
      return;
    }
    const url = URL.createObjectURL(blob), a = el("a", { href: url, download: filename, hidden: true });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`Saved “${filename}” (see your Downloads)`);
  }
  busy(msg) {
    const box = this.busyBox; box.hidden = false;
    box.querySelector(".busymsg").textContent = msg; box.querySelector(".fill").style.width = "0%";
    return { set: (f) => { box.querySelector(".fill").style.width = Math.round(f * 100) + "%"; }, done: () => { box.hidden = true; } };
  }
  async pasteButton(panel) {
    this.setActive(panel);
    try {
      for (const it of await navigator.clipboard.read()) {
        const type = it.types.find((t) => t.startsWith("image/"));
        if (type) { await panel.insertImageBlob(await it.getType(type)); return; }
      }
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) panel.insertText(text); else toast("The clipboard is empty.");
    } catch {
      toast("Paste is not allowed here. Press Ctrl+V, or use the Image button to pick a picture.", 5000);
    }
  }
  onPaste(e) {
    const t = e.target;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;           // normal text paste
    const p = this.active; if (!p || !p.hasPage) return;
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find((i) => i.kind === "file" && i.type.startsWith("image/"));
    if (img) { e.preventDefault(); p.insertImageBlob(img.getAsFile()); return; }
    const text = e.clipboardData?.getData("text/plain");
    if (text && text.trim()) { e.preventDefault(); p.insertText(text); }
  }
  panelAt(x, y) { const e = document.elementFromPoint(x, y)?.closest?.(".panel"); return e ? this.panels[e.dataset.key] : null; }
  async onDrop(e) {
    e.preventDefault();
    const at = this.panelAt(e.clientX, e.clientY);
    for (const f of e.dataTransfer?.files || []) {
      const n = f.name.toLowerCase();
      if (n.endsWith(".dnws")) await this.openWorkspaceFile(f);
      else if (n.endsWith(".pdf") || f.type === "application/pdf") {
        const p = at && at.kind === "pdf" && this.order.includes(at.key) ? at : await this.ensurePanelOfKind("pdf");
        if (p && await this.confirmReplace(p, "open another PDF")) await p.openPdfBytes(new Uint8Array(await f.arrayBuffer()), f.name);
      } else if (n.endsWith(".dnboard")) {
        const p = at && at.kind === "board" && this.order.includes(at.key) ? at : await this.ensurePanelOfKind("board");
        if (p && await this.confirmReplace(p, "open another board")) { try { p.setBoard(M.parseBoard(await f.text()), f.name); } catch (err) { toast(err.message, 4000); } }
      } else if (n.endsWith(".dnote")) {
        const p = at && at.kind === "nb" && this.order.includes(at.key) ? at : await this.ensurePanelOfKind("nb");
        if (p && await this.confirmReplace(p, "open another notebook")) { try { p.setNotebook(M.parseNotebook(await f.text()), f.name); } catch (err) { toast(err.message, 4000); } }
      } else if (f.type.startsWith("image/")) {
        const p = at && at.hasPage ? at : this.active;
        if (p) await p.insertImageBlob(f);
      }
    }
  }
  endTempHand() { if (this.tempHeld) { this.tempHeld.endTempTool(); this.tempHeld = null; } }
  focusPanel(i) {
    const key = this.order[i];
    if (!key) return;
    if (this.narrow) this.setTab(i);
    this.setActive(this.panels[key]);
  }
  /**
   * The one keyboard entry point (a single document listener; nothing else handles keys except text boxes, which stop their own events).
   * Order matters: dialog > Ctrl+S > text field (typing owns the keyboard) > focused button > open menu > shortcuts.
   * Letters use keyName(), so shortcuts also work on a Persian (or any non-Latin) keyboard layout.
   */
  onKey(e) {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;       // already handled / IME composition in progress
    const t = e.target, p = this.active, mod = e.ctrlKey || e.metaKey, key = K.keyName(e);
    if (document.querySelector(".backdrop")) return;                            // a dialog is open: it owns the keyboard (it handles its own Escape)
    if (mod && !e.altKey && !e.shiftKey && key === "s") { e.preventDefault(); this.saveWorkspace(); return; }
    if (K.isTextField(t)) return;                                               // typing: Space, letters, Ctrl+Z (text undo) ... are the browser's
    if (K.isFocusedControl(t) && (key === " " || key === "Enter")) return;      // a keyboard-focused button: Enter / Space activate it
    if (document.querySelector(".popup") && key !== "Escape") return;           // an open menu: no shortcuts behind it
    if (key === "Escape") { closePopup(); p?.deselect(); return; }
    if (e.altKey && !mod && /^[1-9]$/.test(key)) { e.preventDefault(); this.focusPanel(+key - 1); return; }
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); p?.goto(p.shown() - 1); return; }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); p?.goto(p.shown() + 1); return; }
    if (mod && !e.altKey) {                                                     // undo / redo use the panel's own history (and ignore a stroke in progress)
      if (key === "z") { e.preventDefault(); if (e.shiftKey) p?.redo(); else p?.undo(); return; }
      if (key === "y" && !e.shiftKey) { e.preventDefault(); p?.redo(); return; }
      if (p?.handleKey(e, key)) e.preventDefault();
      return;
    }
    if (key === " " && !e.altKey) {                                             // hold Space: Hand tool until the key is released
      e.preventDefault();
      if (!e.repeat && p && !p.root.hidden && p.beginTempTool("pan")) this.tempHeld = p;
      return;
    }
    if (key === "?") { e.preventDefault(); this.shortcuts(); return; }
    if (p?.boardKey?.(e)) { e.preventDefault(); return; }                       // board: Tab = child node, Enter = sibling, F2 = edit
    if (e.key === "Delete" || e.key === "Backspace") { if (p?.deleteSelected()) e.preventDefault(); return; }
    if (p?.handleKey(e, key)) e.preventDefault();
  }
  shortcuts() {
    const rows = (list) => list.map(([label, keys]) => el("div", { class: "krow" }, el("span", {}, label),
      el("span", { class: "keys" }, ...keys.split("  /  ").flatMap((k, i) => (i ? [" / ", el("kbd", {}, k)] : [el("kbd", {}, k)])))));
    return dialog({ title: "Keyboard shortcuts", content: el("div", { class: "kbdlist" },
      ...K.SHORTCUT_GROUPS.map(([title, list]) => el("div", { class: "kgroup" }, el("h3", {}, title), ...rows(list))),
      el("p", { class: "muted" }, "Shortcuts are switched off while you type in a text box, a field or a dialog, so letters and Space are always typed normally.")) });
  }
  async help() {
    const r = await dialog({ title: "DualNote - quick help", buttons: [{ label: "Keyboard shortcuts", value: "keys" }, { label: "Close", value: true, primary: true }], content: el("div", { class: "help" },
      el("p", {}, el("b", {}, "Touch: "), "one finger draws with the chosen tool; two fingers scroll and pinch-zoom. With the Select or Hand tool, drag to scroll. While a pen/stylus is in use, finger touches are ignored (palm rejection)."),
      el("p", {}, el("b", {}, "Board: "), "a big canvas for sketches and mind maps. Switch between a white board and a blackboard with the sun / moon button (your ink adapts, nothing is changed). Mind map: use the Node tool to add nodes, drag from a node with the Link tool to connect, Tab adds a child, Enter a sibling, double-tap a node or connector to edit its text."),
      el("p", {}, el("b", {}, "Layout: "), "the Layout menu chooses which panels the workspace has (up to three: PDF, Notebook, Board). Use “Customize panels…” for any order or a second PDF / Notebook / Board."),
      el("p", {}, el("b", {}, "PDF pages: "), "pages are laid out one after another - just scroll (mouse wheel, two fingers, or the Hand tool). The page box jumps to a page number; the arrows move one page."),
      el("p", {}, el("b", {}, "Edit: "), "Select an item to move it or drag the round handles to resize it. Double-tap text and notes to edit. Delete key or the Eraser removes items."),
      el("p", {}, el("b", {}, "Keyboard: "), "V select, H hand (or hold Space), P pen, E eraser, T text ..., Ctrl+Z / Ctrl+Shift+Z undo / redo. Press ? for the full list."),
      el("p", {}, el("b", {}, "Pictures: "), "Press Ctrl+V (or the Paste button) to paste a screenshot, or use the Image button / drag a picture onto a page."),
      el("p", {}, el("b", {}, "Saving: "), "Save workspace keeps the PDF, all annotations and both notebooks in ONE file (also opens in the Windows app). Your session is also kept automatically on this device."),
      el("p", { class: "muted" }, "Annotated PDFs show your drawings as images on the page and embed the original + editable data, so they reopen editable here and in the Windows app.")) });
    if (r === "keys") this.shortcuts();
  }

  // ----------------------------------------------------------- workspace
  onChange(panel, info = {}) {
    if (info.clean) panel.ui();
    this.scheduleAutosave();
  }
  isPristine(p) { return !p.dirty && !p.name && p.pages.length === 1 && !p.items.length; }
  settings() {
    const P = this.panels;
    return { window: { layout: [...this.order], view: this.viewMode, tab: this.tab, type: M.workspaceTypeOf(this.order) || "custom" }, board: P.board.viewState(), board2: P.board2.viewState(), pdf: P.pdf.viewState(), pdf2: P.pdf2.viewState(), notebook: P.nb.viewState(), notebook2: P.nb2.viewState() };
  }
  nbPages(p) { p.finishEdit(); return p.pages.map((q) => ({ paper: q.paper, items: q.items.slice() })); }
  /** What belongs to the workspace. Default: only the panels of the current structure (a PDF-only workspace has no notebook, and vice versa).
   *  all: true (session backup) also includes panels that were taken out of the structure, so nothing is lost if the tab is reloaded. */
  collect({ all = false } = {}) {
    const P = this.panels, inc = (k) => all || this.order.includes(k);
    return { pdf: inc("pdf") ? P.pdf.workspaceData() : null, pdf2: inc("pdf2") ? P.pdf2.workspaceData() : null,
      notebook: inc("nb") ? this.nbPages(P.nb) : null,
      notebook2: this.order.includes("nb2") || (all && !this.isPristine(P.nb2)) ? this.nbPages(P.nb2) : null,
      board: inc("board") ? P.board.boardData() : null,
      board2: this.order.includes("board2") || (all && !this.isPristine(P.board2)) ? P.board2.boardData() : null,
      settings: this.settings(), type: M.workspaceTypeOf(this.order) || "custom" };
  }
  async saveWorkspace() {
    const busy = this.busy("Saving workspace…");
    try {
      const blob = await WS.writeWorkspace(this.collect());
      await this.saveBlob(blob, this.wsName || "workspace.dnws");
      for (const [k, p] of Object.entries(this.panels)) { if (this.order.includes(k)) p.dirty = false; p.ui(); }    // panels outside the workspace were not saved
    } catch (e) { console.error(e); toast("Could not save the workspace: " + (e.message || e), 5000); }
    finally { busy.done(); }
  }
  async confirmDiscard() {
    if (!this.anyDirty()) return true;
    const c = await dialog({ title: "Unsaved changes", content: "Some changes are not saved in a file. (They are kept on this device automatically, but opening something else replaces them.) Save the workspace first?",
      buttons: [{ label: "Cancel", value: "cancel" }, { label: "Don't save", value: "dont", danger: true }, { label: "Save workspace", value: "save", primary: true }] });
    if (!c || c === "cancel") return false;
    if (c === "save") await this.saveWorkspace();
    return true;
  }
  async newWorkspace() {
    if (!(await this.confirmDiscard())) return;
    await this.restore({ pdf: null, pdf2: null, notebook: [{ paper: "lined", items: [] }], notebook2: null, settings: {} });
    this.wsName = null;
    try { await idb.del("session"); } catch { /* ignore */ }
  }
  async onWorkspaceFile() { const f = this.wsOpenInput.files[0]; this.wsOpenInput.value = ""; if (f) await this.openWorkspaceFile(f); }
  async openWorkspaceFile(file) {
    if (!(await this.confirmDiscard())) return false;
    const busy = this.busy("Opening workspace…");
    try {
      const ws = await WS.readWorkspace(await file.arrayBuffer());
      await this.restore(ws);
      this.wsName = file.name;
      toast("Workspace opened.");
      return true;
    } catch (e) { toast(e.message || "Could not open this workspace.", 5000); return false; }
    finally { busy.done(); }
  }
  /** Rebuild all four panels from workspace data (validated by readWorkspace). */
  async restore(ws) {
    const P = this.panels, st = ws.settings || {}, win = st.window && typeof st.window === "object" ? st.window : {};
    const pdfs = [["pdf", ws.pdf, st.pdf], ["pdf2", ws.pdf2, st.pdf2]];
    for (const [key, data, view] of pdfs) {
      const p = P[key];
      if (!data) { p.clearPdf(); continue; }
      if (!(await p.openPdfBytes(data.source, data.name, { workspace: data }))) throw new Error("The PDF in this workspace could not be opened.");
      await p.goto(Number.isInteger(view?.page) ? view.page : 0);
    }
    P.nb.setNotebook(ws.notebook || [{ paper: "lined", items: [] }], null);
    P.nb2.setNotebook(ws.notebook2 || [{ paper: "lined", items: [] }], null);
    for (const [key, view] of [["nb", st.notebook], ["nb2", st.notebook2]]) { if (Number.isInteger(view?.page)) await P[key].goto(view.page); }
    const blankBoard = { paper: "white", grid: false, items: [] };
    P.board.setBoard(ws.board || blankBoard, null); P.board2.setBoard(ws.board2 || blankBoard, null);
    for (const [key, view] of [["pdf", st.pdf], ["pdf2", st.pdf2], ["nb", st.notebook], ["nb2", st.notebook2], ["board", st.board], ["board2", st.board2]]) P[key].restoreView(view);
    // workspace type from the file's metadata; older files have none: their saved layout is used (PDF + Notebook when nothing is saved)
    let order = M.layoutOfType(ws.type ?? ws.manifest?.workspace_type) || M.sanitizeLayout(win.layout);
    if (order.includes("nb2") && !ws.notebook2) order = [...M.DEFAULT_LAYOUT];
    this.order = order; this.viewMode = M.normalizeView(win.view ?? "both", order);
    this.tab = Number.isInteger(win.tab) ? Math.max(0, Math.min(order.length - 1, win.tab)) : (win.view === "right" ? 1 : 0);
    for (const p of Object.values(P)) p.dirty = false;
    this.refreshLayout();
    for (const p of Object.values(P)) p.ui();
    this.scheduleAutosave();
  }

  // ------------------------------------------------------------- autosave
  scheduleAutosave() { clearTimeout(this.autosaveTimer); this.autosaveTimer = setTimeout(() => this.autosave(), 2500); }
  flushAutosave() { if (this.autosaveTimer) { clearTimeout(this.autosaveTimer); this.autosave(true); } }
  async autosave(force = false) {
    this.autosaveTimer = 0;
    // collecting the data closes any open text editor: never do that in the middle of typing (wait until the user is done)
    if (!force && Object.values(this.panels).some((p) => p.editing)) { this.scheduleAutosave(); return; }
    try {
      const d = this.collect({ all: true }), rec = { version: 1, saved: Date.now(), settings: d.settings, notebook: d.notebook, notebook2: d.notebook2, board: d.board, board2: d.board2 };
      const keep = new Set();
      for (const key of ["pdf", "pdf2"]) {
        const p = d[key];
        if (!p) { rec[key] = null; continue; }
        const panel = this.panels[key].pdf;
        panel.hash = panel.hash || await WS.sha256Hex(p.source);
        const k = "pdf:" + panel.hash; keep.add(k);
        if (!(await idb.get(k))) await idb.set(k, p.source);
        rec[key] = { name: p.name, hash: panel.hash, pages: p.pages };
      }
      await idb.set("session", rec);
      for (const k of await idb.keys()) if (String(k).startsWith("pdf:") && !keep.has(k)) await idb.del(k);
      this.autosaveOk = true;
    } catch (e) { console.warn("autosave failed", e); this.autosaveOk = false; }
  }
  async restoreAutosave() {
    try {
      const rec = await idb.get("session");
      if (!rec || rec.version !== 1) return false;
      const bd = (b) => (b ? M.parseBoard(M.boardToJson(b)) : null);       // sanitised copy
      const ws = { settings: rec.settings || {}, board: bd(rec.board), board2: bd(rec.board2), notebook: M.parseNotebook(M.notebookToJson(rec.notebook)), notebook2: rec.notebook2 ? M.parseNotebook(M.notebookToJson(rec.notebook2)) : null, pdf: null, pdf2: null };
      for (const key of ["pdf", "pdf2"]) {
        const r = rec[key]; if (!r) continue;
        const source = await idb.get("pdf:" + r.hash);
        if (!source) continue;
        const pages = M.parsePdfAnnotations(M.pdfAnnotationsToJson(r.pages), r.pages.length);
        if (pages) ws[key] = { name: r.name, source, pages };
      }
      const empty = !ws.pdf && !ws.pdf2 && ws.notebook.every((p) => !p.items.length) && (!ws.notebook2 || ws.notebook2.every((p) => !p.items.length))
        && !ws.board?.items.length && !ws.board2?.items.length;
      if (empty) return false;
      await this.restore(ws);
      // The restored work only exists in this browser's storage, not in a file: keep it marked unsaved,
      // so "New", closing and similar actions still offer to save it.
      for (const p of Object.values(this.panels)) { p.dirty = p.pages.some((q) => q.items.length > 0); p.ui(); }
      toast("Your last session was restored.");
      return true;
    } catch (e) { console.warn("could not restore the last session", e); return false; }
  }
}

export async function start() {
  const app = new App(document.getElementById("app"));
  window.dualnote = app;
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
  await app.restoreAutosave();
  return app;
}
