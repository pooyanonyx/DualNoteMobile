// DualNote (web / Android): application shell - layout, workspace files, autosave, dialogs, shortcuts.
import * as M from "./model.js";
import * as WS from "./workspace.js";
import { Panel } from "./panel.js";
import { setImageLoadedCallback } from "./render.js";
import { el, icon, toast, dialog, popup, closePopup } from "./ui.js";

const NARROW = 860;                                  // below this width only one panel is shown at a time
const LAYOUTS = [["PDF | Notebook  (default)", ["pdf", "nb"]], ["Notebook | PDF", ["nb", "pdf"]],
  ["Notebook | Notebook", ["nb", "nb2"]], ["PDF | PDF", ["pdf", "pdf2"]]];

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
    this.order = [...M.DEFAULT_LAYOUT]; this.viewMode = "both"; this.active = null;
    this.panels = { pdf: new Panel(this, "pdf", "pdf", "PDF"), pdf2: new Panel(this, "pdf2", "pdf", "PDF 2"),
      nb: new Panel(this, "nb", "nb", "Notebook"), nb2: new Panel(this, "nb2", "nb", "Notebook 2") };
    this.autosaveOk = true; this.autosaveTimer = 0; this.wsName = null; this.installEvt = null;
    setImageLoadedCallback(() => { for (const p of Object.values(this.panels)) p.render(); });   // pictures that finish decoding appear at once
    this.buildDom();
    this.refreshLayout();
    window.addEventListener("resize", () => this.refreshLayout());
    window.addEventListener("beforeunload", (e) => { this.flushAutosave(); if (this.anyDirty() && !this.autosaveOk) { e.preventDefault(); e.returnValue = ""; } });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") this.flushAutosave(); });
    window.addEventListener("pagehide", () => this.flushAutosave());
    document.addEventListener("keydown", (e) => this.onKey(e));
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
    this.layoutBtn = b("layout", "Layout", "Choose what is shown on the left and the right", () => this.openLayoutMenu());
    this.switchBtn = b("swap", "Switch", "Swap the left and right panels (nothing is closed or lost)", () => this.switchSides());
    this.seg = el("div", { class: "seg", role: "tablist" });
    this.installBtn = b("plus", "Install", "Install DualNote as an app", async () => { if (this.installEvt) { this.installEvt.prompt(); this.installEvt = null; this.installBtn.hidden = true; } }, "primary");
    this.installBtn.hidden = true;
    this.top = el("header", { class: "topbar" },
      el("span", { class: "brand" }, "DualNote"),
      b("open", "Open workspace", "Open a workspace file (.dnws)", () => this.wsOpenInput.click()),
      b("save", "Save workspace", "Save everything (PDF, annotations, notebooks) in one file (Ctrl+S)", () => this.saveWorkspace()),
      b("plus", "New", "Start a new empty workspace", () => this.newWorkspace()),
      el("span", { class: "gap" }), this.layoutBtn, this.switchBtn, this.seg, this.installBtn,
      b("menu", "", "Help", () => this.help(), "icon-only"), this.wsOpenInput);
    this.main = el("main", { class: "main" });
    for (const k of Object.keys(this.panels)) this.main.append(this.panels[k].root);
    this.busyBox = el("div", { class: "busy", hidden: true }, el("div", { class: "busybox" }, el("div", { class: "spin" }), el("div", { class: "busymsg" }), el("div", { class: "bar2" }, el("div", { class: "fill" }))));
    this.root.append(this.top, this.main, this.busyBox);
  }
  name(key) {
    const o = this.order;
    if (key === "pdf") return o.includes("pdf2") ? "PDF 1" : "PDF";
    if (key === "pdf2") return "PDF 2";
    if (key === "nb2") return "Notebook 2";
    return o.includes("nb2") ? "Notebook 1" : "Notebook";
  }
  get narrow() { return window.innerWidth < NARROW; }
  effectiveView() { const v = this.viewMode; return this.narrow && v === "both" ? "left" : v; }
  refreshLayout() {
    const view = this.effectiveView(), shown = { both: this.order, left: this.order.slice(0, 1), right: this.order.slice(1) }[view];
    for (const [k, p] of Object.entries(this.panels)) {
      p.root.hidden = !shown.includes(k); p.root.style.order = String(this.order.indexOf(k) < 0 ? 9 : this.order.indexOf(k));
      p.setLabel(this.name(k));
    }
    this.root.dataset.narrow = String(this.narrow);
    this.seg.replaceChildren();
    const opts = this.narrow ? [["left", this.name(this.order[0])], ["right", this.name(this.order[1])]]
      : [["left", this.name(this.order[0]) + " only"], ["both", "Both"], ["right", this.name(this.order[1]) + " only"]];
    for (const [v, text] of opts) {
      this.seg.append(el("button", { class: "segbtn" + (v === view ? " on" : ""), type: "button", role: "tab", "aria-selected": String(v === view),
        onclick: () => this.setView(v) }, text));
    }
    for (const k of shown) this.panels[k].onResize();
    if (!shown.includes(this.active?.key)) this.setActive(this.panels[shown[0]]);
  }
  setView(mode) { this.viewMode = M.normalizeView(mode, this.order); this.refreshLayout(); this.scheduleAutosave(); }
  setActive(p) { if (this.active === p) return; this.active = p; for (const q of Object.values(this.panels)) q.root.classList.toggle("active", q === p); }
  openLayoutMenu() {
    const box = el("div", { class: "menu" }, LAYOUTS.map(([label, order]) => el("button", { class: "mi" + (this.order.join() === order.join() ? " on" : ""), type: "button",
      onclick: () => { closePopup(); this.setLayout(order); } }, el("span", { class: "chk" }, this.order.join() === order.join() ? "✓" : ""), label)));
    popup(this.layoutBtn, box);
  }
  switchSides() { this.setLayout([...this.order].reverse(), false); }
  async setLayout(order, ask = true) {
    order = M.sanitizeLayout(order);
    if (order.join() === this.order.join()) { this.refreshLayout(); return true; }
    if (ask) for (const key of M.hiddenByLayoutChange(this.order, order)) if (!(await this.confirmHide(key))) return false;
    this.order = order; this.viewMode = "both";
    this.refreshLayout(); this.scheduleAutosave();
    return true;
  }
  async confirmHide(key) {
    const p = this.panels[key];
    if (!p.dirty || (p.kind === "pdf" && !p.hasPage)) return true;
    const what = p.kind === "pdf" ? "annotated PDF" : "notebook file";
    const choice = await dialog({ title: "Unsaved changes",
      content: el("div", {}, el("p", {}, `${this.name(key)} has changes that are not saved, and it is about to be replaced on screen.`),
        el("p", {}, `Do you want to save it separately (as an ${what}) first?`),
        el("p", { class: "muted" }, "If you choose “No”, it is not thrown away: it stays open in the background, and you will be asked again before it is closed.")),
      buttons: [{ label: "Cancel", value: "cancel" }, { label: "No, don't save", value: "dont", danger: true }, { label: "Yes, save it", value: "save", primary: true }] });
    if (!choice || choice === "cancel") return false;
    if (choice === "save") return p.saveSeparately();
    return true;
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
        const p = at && at.kind === "pdf" ? at : this.order.map((k) => this.panels[k]).find((q) => q.kind === "pdf") || this.panels.pdf;
        if (await this.confirmReplace(p, "open another PDF")) await p.openPdfBytes(new Uint8Array(await f.arrayBuffer()), f.name);
      } else if (n.endsWith(".dnote")) {
        const p = at && at.kind === "nb" ? at : this.order.map((k) => this.panels[k]).find((q) => q.kind === "nb") || this.panels.nb;
        if (await this.confirmReplace(p, "open another notebook")) { try { p.setNotebook(M.parseNotebook(await f.text()), f.name); } catch (err) { toast(err.message, 4000); } }
      } else if (f.type.startsWith("image/")) {
        const p = at && at.hasPage ? at : this.active;
        if (p) await p.insertImageBlob(f);
      }
    }
  }
  onKey(e) {
    const t = e.target, typing = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT");
    const mod = e.ctrlKey || e.metaKey, p = this.active;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); this.saveWorkspace(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); p?.undo(); }
    else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); p?.redo(); }
    else if (e.key === "Delete" || e.key === "Backspace") { if (p?.deleteSelected()) e.preventDefault(); }
    else if (e.key === "Escape") { closePopup(); p?.deselect(); }
    else if (e.altKey && e.key === "ArrowLeft") { p?.goto(p.shown() - 1); }
    else if (e.altKey && e.key === "ArrowRight") { p?.goto(p.shown() + 1); }
  }
  help() {
    dialog({ title: "DualNote - quick help", content: el("div", { class: "help" },
      el("p", {}, el("b", {}, "Touch: "), "one finger draws with the chosen tool; two fingers scroll and pinch-zoom. With the Select or Hand tool, drag to scroll. While a pen/stylus is in use, finger touches are ignored (palm rejection)."),
      el("p", {}, el("b", {}, "PDF pages: "), "pages are laid out one after another - just scroll (mouse wheel, two fingers, or the Hand tool). The page box jumps to a page number; the arrows move one page."),
      el("p", {}, el("b", {}, "Edit: "), "Select an item to move it or drag the round handles to resize it. Double-tap text and notes to edit. Delete key or the Eraser removes items."),
      el("p", {}, el("b", {}, "Pictures: "), "Press Ctrl+V (or the Paste button) to paste a screenshot, or use the Image button / drag a picture onto a page."),
      el("p", {}, el("b", {}, "Saving: "), "Save workspace keeps the PDF, all annotations and both notebooks in ONE file (also opens in the Windows app). Your session is also kept automatically on this device."),
      el("p", { class: "muted" }, "Annotated PDFs show your drawings as images on the page and embed the original + editable data, so they reopen editable here and in the Windows app.")) });
  }

  // ----------------------------------------------------------- workspace
  onChange(panel, info = {}) {
    if (info.clean) panel.ui();
    this.scheduleAutosave();
  }
  isPristine(p) { return !p.dirty && !p.name && p.pages.length === 1 && !p.items.length; }
  settings() {
    const P = this.panels;
    return { window: { layout: [...this.order], view: this.viewMode }, pdf: P.pdf.viewState(), pdf2: P.pdf2.viewState(), notebook: P.nb.viewState(), notebook2: P.nb2.viewState() };
  }
  nbPages(p) { p.finishEdit(); return p.pages.map((q) => ({ paper: q.paper, items: q.items.slice() })); }
  collect() {
    const P = this.panels;
    return { pdf: P.pdf.workspaceData(), pdf2: P.pdf2.workspaceData(), notebook: this.nbPages(P.nb),
      notebook2: this.order.includes("nb2") || !this.isPristine(P.nb2) ? this.nbPages(P.nb2) : null, settings: this.settings() };
  }
  async saveWorkspace() {
    const busy = this.busy("Saving workspace…");
    try {
      const blob = await WS.writeWorkspace(this.collect());
      await this.saveBlob(blob, this.wsName || "workspace.dnws");
      for (const p of Object.values(this.panels)) { p.dirty = false; p.ui(); }
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
    P.nb.setNotebook(ws.notebook, null);
    P.nb2.setNotebook(ws.notebook2 || [{ paper: "lined", items: [] }], null);
    for (const [key, view] of [["nb", st.notebook], ["nb2", st.notebook2]]) { if (Number.isInteger(view?.page)) await P[key].goto(view.page); }
    for (const [key, view] of [["pdf", st.pdf], ["pdf2", st.pdf2], ["nb", st.notebook], ["nb2", st.notebook2]]) P[key].restoreView(view);
    let order = M.sanitizeLayout(win.layout);
    if (order.includes("nb2") && !ws.notebook2) order = [...M.DEFAULT_LAYOUT];
    this.order = order; this.viewMode = M.normalizeView(win.view ?? "both", order);
    for (const p of Object.values(P)) p.dirty = false;
    this.refreshLayout();
    for (const p of Object.values(P)) p.ui();
    this.scheduleAutosave();
  }

  // ------------------------------------------------------------- autosave
  scheduleAutosave() { clearTimeout(this.autosaveTimer); this.autosaveTimer = setTimeout(() => this.autosave(), 2500); }
  flushAutosave() { if (this.autosaveTimer) { clearTimeout(this.autosaveTimer); this.autosave(); } }
  async autosave() {
    this.autosaveTimer = 0;
    try {
      const d = this.collect(), rec = { version: 1, saved: Date.now(), settings: d.settings, notebook: d.notebook, notebook2: d.notebook2 };
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
      const ws = { settings: rec.settings || {}, notebook: M.parseNotebook(M.notebookToJson(rec.notebook)), notebook2: rec.notebook2 ? M.parseNotebook(M.notebookToJson(rec.notebook2)) : null, pdf: null, pdf2: null };
      for (const key of ["pdf", "pdf2"]) {
        const r = rec[key]; if (!r) continue;
        const source = await idb.get("pdf:" + r.hash);
        if (!source) continue;
        const pages = M.parsePdfAnnotations(M.pdfAnnotationsToJson(r.pages), r.pages.length);
        if (pages) ws[key] = { name: r.name, source, pages };
      }
      const empty = !ws.pdf && !ws.pdf2 && ws.notebook.every((p) => !p.items.length) && (!ws.notebook2 || ws.notebook2.every((p) => !p.items.length));
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
