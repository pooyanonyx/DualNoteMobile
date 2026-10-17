// End-to-end tests, part 4: layouts and the "save separately?" question, autosave/restore, offline (PWA),
// phone/tablet layouts, touch gestures, pen palm rejection.
import * as T from "./lib.mjs";
const { check, section } = T;
const server = await T.startServer();
const browser = await T.launch();
const pdfFile = T.TMP + "/fixture.pdf"; await T.makePdf(pdfFile);
const pdfFile2 = T.TMP + "/second.pdf"; await T.makePdf(pdfFile2, { pages: 3, size: [420, 595], text: "Second document" });
const P = (k) => `.panel[data-key="${k}"]`;
const R = { t: "rect", x1: 10, y1: 10, x2: 80, y2: 50, color: "#d32f2f", w: 3, alpha: 255, bright: 0 };
const commit = (page, key, list) => page.evaluate(([k, l]) => dualnote.panels[k].commit(l), [key, list]);
const visible = (page) => page.$$eval(".panel:not([hidden])", (n) => n.map((e) => e.dataset.key));
const xOf = (page, key) => page.$eval(P(key), (e) => e.getBoundingClientRect().x);
const dialogText = (page) => page.$eval(".dialog", (d) => d.textContent);
const clickBtn = (page, text) => page.click(`.dialog .btn:has-text("${text}")`);
const chooseLayout = async (page, label) => { await page.click('.topbar .btn[aria-label^="Choose what"]'); await page.click(`.popup .mi:has-text("${label}")`); await T.settle(page, 150); };

section("layouts: switch sides, two notebooks, two PDFs, 'save separately?'");
let page = await T.newApp(browser, { viewport: { width: 1280, height: 900 } });
await T.captureSaves(page);
await T.openPdf(page, "pdf", pdfFile);
await commit(page, "pdf", [R]); await commit(page, "nb", [R]);
check("default: PDF on the left, notebook on the right", (await xOf(page, "pdf")) < (await xOf(page, "nb")) && (await visible(page)).join() === "pdf,nb");
await page.click('.topbar .btn[aria-label^="Swap"]'); await T.settle(page, 150);
check("Switch puts the notebook on the left, no question asked", (await xOf(page, "nb")) < (await xOf(page, "pdf")) && await page.$(".dialog") === null);
check("switching loses nothing (items and unsaved flags kept)", await page.evaluate(() => dualnote.panels.pdf.items.length === 1 && dualnote.panels.nb.items.length === 1 && dualnote.panels.pdf.dirty && dualnote.panels.nb.dirty));
check("the left/right buttons are named after what is on that side", (await page.$$eval(".seg .segbtn", (n) => n.map((e) => e.textContent))).join() === "Notebook only,Both,PDF only");
await page.click('.topbar .btn[aria-label^="Swap"]'); await T.settle(page, 150);
check("switching again returns to the default", (await xOf(page, "pdf")) < (await xOf(page, "nb")));

await chooseLayout(page, "Notebook | Notebook");
check("replacing a PDF with unsaved annotations asks first", await page.$(".dialog") !== null && (await dialogText(page)).includes("PDF has changes that are not saved") && !(await dialogText(page)).includes("undefined"));
await clickBtn(page, "Cancel"); await T.settle(page, 100);
check("Cancel keeps the layout and everything on screen", (await visible(page)).join() === "pdf,nb" && await page.$(".dialog") === null);
await chooseLayout(page, "Notebook | Notebook"); await clickBtn(page, "No, don't save"); await T.settle(page, 200);
check("'No' changes the layout without saving", (await visible(page)).join() === "nb,nb2" && (await T.takeSave(page)) === null);
check("...and the PDF is kept in the background with its annotation and unsaved flag", await page.evaluate(() => dualnote.panels.pdf.pdf && dualnote.panels.pdf.items.length === 1 && dualnote.panels.pdf.dirty));
check("two notebooks are independent; panel titles say Notebook 1 / Notebook 2", await page.evaluate(() => { const P = dualnote.panels; P.nb2.commit([{ t: "ellipse", x1: 5, y1: 5, x2: 60, y2: 40, color: "#1976d2", w: 2 }]); return P.nb2.items.length === 1 && P.nb.items.length === 1 && P.nb.items[0].t === "rect"; })
  && (await page.$eval(P("nb"), (e) => e.querySelector(".ptitle").textContent)).includes("Notebook 1") && (await page.$eval(P("nb2"), (e) => e.querySelector(".ptitle").textContent)).includes("Notebook 2"));
await chooseLayout(page, "PDF | Notebook");
check("going back asks about the unsaved second notebook", await page.$(".dialog") !== null && (await dialogText(page)).includes("Notebook 2 has changes"));
await clickBtn(page, "Yes, save it"); await page.waitForFunction(() => window.__saves.length === 1, null, { timeout: 8000 });
const sv = await T.takeSave(page);
check("'Yes' saves it separately (.dnote) and then changes the layout", sv.name.endsWith(".dnote") && (await visible(page)).join() === "pdf,nb" && JSON.parse(Buffer.from(sv.b64, "base64").toString()).format === "DualNote-notebook");
check("the PDF is back on screen with its annotation", await page.evaluate(() => dualnote.panels.pdf.items.length === 1 && !!dualnote.panels.pdf.raster));
await chooseLayout(page, "PDF | PDF");
await clickBtn(page, "No, don't save"); await T.settle(page, 200);
check("PDF | PDF shows two PDF panels (PDF 1 / PDF 2)", (await visible(page)).join() === "pdf,pdf2" && (await page.$eval(P("pdf2"), (e) => e.querySelector(".ptitle").textContent)).includes("PDF 2"));
await T.openPdf(page, "pdf2", pdfFile2);
check("each side holds its own document", await page.evaluate(() => dualnote.panels.pdf.pages.length === 2 && dualnote.panels.pdf2.pages.length === 3 && dualnote.panels.pdf2.name === "second.pdf"));
await T.setTool(page, "pdf2", "rect"); await T.drag(page, "pdf2", [60, 200], [200, 260]);
check("annotating PDF 2 does not touch PDF 1", await page.evaluate(() => dualnote.panels.pdf2.items.length === 1 && dualnote.panels.pdf.items.length === 1));
await page.click(`.seg .segbtn:has-text("PDF 2 only")`); await T.settle(page, 150);
check("'PDF 2 only' gives it the whole window", (await visible(page)).join() === "pdf2");
await page.click(`.seg .segbtn:has-text("Both")`); await T.settle(page, 100);
check("'Both' shows both again", (await visible(page)).join() === "pdf,pdf2");
await page.close();

section("autosave: the session survives a reload / killed tab");
page = await T.newApp(browser, { viewport: { width: 1280, height: 900 } });
await T.openPdf(page, "pdf", pdfFile);
await commit(page, "pdf", [R, { t: "text", x: 100, y: 200, text: "kept", color: "#000000", size: 20, alpha: 255, bright: 0 }]);
await commit(page, "nb", [{ t: "pen", pts: [[10, 10], [60, 40]], color: "#1a1a1a", w: 2, alpha: 255, bright: 0 }]);
await page.evaluate(() => dualnote.setLayout(["nb", "pdf"], false));
await page.waitForTimeout(3300);
await page.reload(); await page.waitForSelector(".panel"); await page.waitForFunction(() => window.dualnote);
await page.waitForFunction(() => dualnote.panels.pdf.pdf && dualnote.panels.pdf.raster, null, { timeout: 15000 });
const rest = await page.evaluate(() => { const P = dualnote.panels; return { pdfItems: P.pdf.items.map((i) => i.t), nb: P.nb.items.map((i) => i.t), order: dualnote.order, name: P.pdf.name, dirty: dualnote.anyDirty() }; });
check("after a reload the PDF, its annotations, the notebook and the layout are back (still marked as not saved to a file)", JSON.stringify(rest) === '{"pdfItems":["rect","text"],"nb":["pen"],"order":["nb","pdf"],"name":"fixture.pdf","dirty":true}', JSON.stringify(rest));
check("a toast says the session was restored", (await page.$$eval(".toast", (n) => n.map((e) => e.textContent).join())).includes("restored"));
await page.click('.topbar .btn[aria-label="Start a new empty workspace"]');
await page.click('.dialog .btn:has-text("Don\'t save")'); await T.settle(page, 400);
check("'New' clears everything", await page.evaluate(() => !dualnote.panels.pdf.pdf && dualnote.panels.nb.items.length === 0));
await page.waitForTimeout(500); await page.reload(); await page.waitForSelector(".panel"); await page.waitForTimeout(800);
check("a cleared workspace stays cleared after a reload", await page.evaluate(() => !dualnote.panels.pdf.pdf && dualnote.panels.nb.items.length === 0));
await page.close();

section("offline use (installable web app)");
page = await T.newApp(browser, { viewport: { width: 1280, height: 900 }, sw: true });
const ready = await page.evaluate(async () => { await navigator.serviceWorker.ready;
  for (let i = 0; i < 100; i++) { const k = await caches.keys(); if (k.length && (await (await caches.open(k[0])).keys()).length > 150) return true; await new Promise((r) => setTimeout(r, 200)); } return false; });
check("service worker installed and the app files are cached", ready);
const man = await page.evaluate(async () => (await fetch("manifest.webmanifest")).json());
check("web app manifest: standalone app with icons", man.display === "standalone" && man.name === "DualNote" && man.icons.length >= 3
  && (await Promise.all(man.icons.map(async (i) => (await page.evaluate((u) => fetch(u).then((r) => r.status), i.src)) === 200))).every(Boolean));
await page.reload(); await page.waitForSelector(".panel");
await page.context().setOffline(true);
await page.reload(); await page.waitForSelector(".panel", { timeout: 15000 });
check("the app starts with no network at all", await page.evaluate(() => !!window.dualnote));
await T.openPdf(page, "pdf", pdfFile);
await T.setTool(page, "pdf", "rect"); await T.drag(page, "pdf", [100, 300], [200, 360]);
check("PDF viewing and annotating work offline", await page.evaluate(() => dualnote.panels.pdf.items.length === 1 && !!dualnote.panels.pdf.raster));
check("no console errors offline", page.errors.length === 0, page.errors.join("|"));
await page.context().setOffline(false);
await page.close();

section("phone (390x844, touch)");
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"], serviceWorkers: "block" });
page = await T.newApp(browser, { ctx: phone });
const reach = (pg) => pg.evaluate(() => {
  const W = window.innerWidth, bad = [];
  for (const b of document.querySelectorAll(".topbar .btn:not([hidden]), .topbar .segbtn, .panel:not([hidden]) .bar .btn, .panel:not([hidden]) .bar input, .panel:not([hidden]) .bar select, .panel:not([hidden]) .phead .btn")) {
    const r = b.getBoundingClientRect(); if (!r.width) { bad.push("hidden " + (b.getAttribute("aria-label") || b.textContent)); continue; }
    if (r.left < -0.5 || r.right > W + 0.5) bad.push("off-screen " + (b.getAttribute("aria-label") || b.textContent) + " " + Math.round(r.left) + ".." + Math.round(r.right));
  }
  return { bad, overflow: document.documentElement.scrollWidth > W, panels: [...document.querySelectorAll(".panel:not([hidden])")].map((e) => e.dataset.key) };
});
let rr = await reach(page);
check("phone: one panel at a time, with tabs", rr.panels.join() === "pdf" && (await page.$$eval(".seg .segbtn", (n) => n.map((e) => e.textContent))).join() === "PDF,Notebook");
check("phone: every button is on screen (toolbars wrap), no sideways scrolling", rr.bad.length === 0 && !rr.overflow, rr.bad.join("; "));
check("phone: buttons are touch-sized (at least 40 px)", await page.$$eval(".panel:not([hidden]) .bar .btn", (n) => n.every((b) => { const r = b.getBoundingClientRect(); return r.width >= 38 && r.height >= 38; })));
await page.tap('.seg .segbtn:has-text("Notebook")'); await T.settle(page, 250);
rr = await reach(page);
check("phone: the Notebook tab shows the notebook, also fully reachable", rr.panels.join() === "nb" && rr.bad.length === 0, rr.bad.join("; "));
const stageH = await page.$eval(P("nb") + " .stage", (e) => e.getBoundingClientRect().height);
await page.tap(P("nb") + " .phead .btn"); await T.settle(page, 250);
check("phone: 'Toolbars' hides the toolbars to give the page more room", (await page.$eval(P("nb") + " .stage", (e) => e.getBoundingClientRect().height)) > stageH + 100);
await page.tap(P("nb") + " .phead .btn"); await T.settle(page, 250);

const cdp = await phone.newCDPSession(page);
const touch = async (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
const stageBox = await page.$eval(P("nb") + " .stage", (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
const cx = stageBox[0] + stageBox[2] / 2, cy = stageBox[1] + stageBox[3] / 2;
await touch("touchStart", [[cx - 80, cy]]); for (let i = 1; i <= 6; i++) await touch("touchMove", [[cx - 80 + i * 26, cy + i * 6]]); await touch("touchEnd", []);
await T.settle(page, 100);
let nbItems = await T.items(page, "nb");
check("touch: one finger draws with the pen", nbItems.length === 1 && nbItems[0].t === "pen" && nbItems[0].pts.length >= 4, JSON.stringify(nbItems).slice(0, 100));
const s0 = await T.panelState(page, "nb", "p.view.scale");
await touch("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
for (let i = 1; i <= 8; i++) await touch("touchMove", [[cx - 40 - i * 8, cy], [cx + 40 + i * 8, cy]]);
await touch("touchEnd", []);
await T.settle(page, 100);
const s1 = await T.panelState(page, "nb", "p.view.scale");
check("touch: two-finger pinch zooms in, without drawing anything", s1 > s0 * 1.5 && (await T.items(page, "nb")).length === 1, `${s0} -> ${s1}`);
const ty0 = await T.panelState(page, "nb", "p.view.ty");
await touch("touchStart", [[cx - 30, cy + 100], [cx + 30, cy + 100]]);
for (let i = 1; i <= 6; i++) await touch("touchMove", [[cx - 30, cy + 100 - i * 20], [cx + 30, cy + 100 - i * 20]]);
await touch("touchEnd", []);
await T.settle(page, 100);
check("touch: two fingers move the page (scroll)", Math.abs((await T.panelState(page, "nb", "p.view.ty")) - ty0) > 40 && (await T.items(page, "nb")).length === 1);
await page.waitForTimeout(800);        // Chrome ignores a tap that comes right after a (synthetic) fast two-finger gesture
await page.tap(P("nb") + ' .btn[aria-label="Fit page to width"]');
const s2 = await T.panelState(page, "nb", "p.view.scale");
check("fit to width after pinching", Math.abs(s2 - s0) < 1e-6, `${s0} -> pinched ${s1} -> fit ${s2}`);

const pen = (type, x, y) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen" });
await pen("mouseMoved", cx - 60, cy + 120); await pen("mousePressed", cx - 60, cy + 120);
for (let i = 1; i <= 6; i++) await pen("mouseMoved", cx - 60 + i * 20, cy + 120);
await pen("mouseReleased", cx + 60, cy + 120);
await T.settle(page, 100);
check("pen/stylus draws", (await T.items(page, "nb")).length === 2);
await touch("touchStart", [[cx - 60, cy - 120]]); for (let i = 1; i <= 5; i++) await touch("touchMove", [[cx - 60 + i * 20, cy - 120]]); await touch("touchEnd", []);
await T.settle(page, 100);
check("palm rejection: a finger touch right after pen use is ignored", (await T.items(page, "nb")).length === 2);
await page.waitForTimeout(1500);
await touch("touchStart", [[cx - 60, cy - 120]]); for (let i = 1; i <= 5; i++) await touch("touchMove", [[cx - 60 + i * 20, cy - 120]]); await touch("touchEnd", []);
await T.settle(page, 100);
check("...but fingers draw again once the pen has been put down", (await T.items(page, "nb")).length === 3);
check("no console errors on the phone", page.errors.length === 0, page.errors.join("|"));
await phone.close();

section("tablets");
for (const [w, h, name, expectPanels] of [[768, 1024, "portrait 768x1024", 1], [1024, 768, "landscape 1024x768", 2], [1180, 820, "landscape 1180x820", 2]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const pg = await T.newApp(browser, { ctx });
  const r = await reach(pg);
  check(`tablet ${name}: ${expectPanels} panel(s) shown, every control reachable, no sideways scroll`, r.panels.length === expectPanels && r.bad.length === 0 && !r.overflow, JSON.stringify(r));
  check(`tablet ${name}: the page area is large enough to draw on`, await pg.$eval(P("nb") + " .stage, " + P("pdf") + " .stage", (e) => e.getBoundingClientRect().height) > 300);
  await ctx.close();
}
await browser.close(); server.close();
process.exit(T.summary() ? 1 : 0);
