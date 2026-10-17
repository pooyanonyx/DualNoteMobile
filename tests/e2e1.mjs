// End-to-end tests, part 1: boot, PDF viewing, every drawing tool, selection/resize, undo, colours, text, notes.
import fs from "node:fs";
import * as T from "./lib.mjs";
const { check, section } = T;
const server = await T.startServer();
const browser = await T.launch();
const pdfFile = T.writeTmp("fixture.pdf", await T.makePdf(T.TMP + "/fixture.pdf"));
const page = await T.newApp(browser, { viewport: { width: 1280, height: 1150 } });

section("boot");
check("default layout: PDF left, notebook right", JSON.stringify(await page.evaluate(() => dualnote.order)) === '["pdf","nb"]'
  && (await page.$$eval(".panel:not([hidden])", (n) => n.map((e) => e.dataset.key))).join() === "pdf,nb");
check("no console errors on start", page.errors.length === 0, page.errors.join(" | "));
check("Install button hidden until the browser offers installation", await page.$eval(".topbar .btn.primary", (b) => getComputedStyle(b).display === "none"));

section("PDF viewing");
await T.openPdf(page, "pdf", pdfFile);
check("PDF opens: title, 2 pages", (await T.panelState(page, "pdf", "p.titleEl.textContent")).includes("fixture.pdf") && await T.panelState(page, "pdf", "p.pages.length") === 2);
check("page size read from the PDF", JSON.stringify(await T.panelState(page, "pdf", "p.sizes[0].map(Math.round)")) === "[595,842]");
const dark = await page.evaluate(() => { const p = dualnote.panels.pdf; p.draw(); const [w] = p.pageDims(); let n = 0;
  const x0 = Math.round((p.view.tx + 72 * p.view.scale) * p.dpr), y0 = Math.round((p.view.ty + 80 * p.view.scale) * p.dpr);
  const d = p.ctx.getImageData(x0, y0, Math.round(300 * p.view.scale * p.dpr), Math.round(30 * p.view.scale * p.dpr)).data;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100) n++; return n; });
check("PDF text is rendered on the canvas", dark > 200, dark);
await page.click('.panel[data-key="pdf"] .btn[aria-label="Next page"]'); await T.settle(page, 400);
check("next page", await T.panelState(page, "pdf", "p.cur") === 1 && await T.panelState(page, "pdf", "p.pageInput.value") === "2");
await page.click('.panel[data-key="pdf"] .btn[aria-label="Previous page"]'); await T.settle(page, 400);
const z0 = await T.panelState(page, "pdf", "p.view.scale");
await page.click('.panel[data-key="pdf"] .btn[aria-label="Zoom in"]');
check("zoom in", (await T.panelState(page, "pdf", "p.view.scale")) > z0 * 1.2);
await page.click('.panel[data-key="pdf"] .btn[aria-label="Fit page to width"]');
check("fit to width restores the zoom", Math.abs((await T.panelState(page, "pdf", "p.view.scale")) - z0) < 1e-6);

section("drawing tools (notebook)");
const NB = "nb";
await T.setTool(page, NB, "pen");
await T.drag(page, NB, [100, 150], [300, 200]);
let it = await T.items(page, NB);
check("pen stroke created in page coordinates", it.length === 1 && it[0].t === "pen" && it[0].pts.length >= 3
  && Math.abs(it[0].pts[0][0] - 100) < 1.5 && Math.abs(it[0].pts[0][1] - 150) < 1.5 && Math.abs(it[0].pts.at(-1)[0] - 300) < 1.5, JSON.stringify(it[0]).slice(0, 120));
check("stroke carries colour, width, opacity, brightness", it[0].color === "#1a1a1a" && it[0].w === 2 && it[0].alpha === 255 && it[0].bright === 0);
check("stroke is actually drawn (pixel on the line)", (await T.pixelAt(page, NB, 200, 175))[0] < 120);
await T.setTool(page, NB, "mark"); await T.drag(page, NB, [100, 260], [300, 260]);
it = await T.items(page, NB);
check("marker: translucent yellow default", it[1].t === "mark" && it[1].color === "#fdd835" && it[1].alpha === 110 && it[1].w === 14);
const mk = await T.pixelAt(page, NB, 200, 260);
check("marker pixel is translucent (not opaque yellow, text underneath stays visible)", mk[0] > 200 && mk[1] > 200 && mk[2] < 245 && mk[2] > 100, mk.join());
await T.setTool(page, NB, "rect"); await T.drag(page, NB, [100, 320], [260, 400]);
await T.setTool(page, NB, "ellipse"); await T.drag(page, NB, [300, 320], [400, 400]);
await T.setTool(page, NB, "line"); await T.drag(page, NB, [100, 450], [250, 470]);
await T.setTool(page, NB, "arrow"); await T.drag(page, NB, [300, 450], [450, 500]);
it = await T.items(page, NB);
check("rect, ellipse, line and arrow tools", it.slice(2).map((i) => i.t).join() === "rect,ellipse,line,arrow");
check("accidental tap with a shape tool creates nothing", await (async () => { await T.setTool(page, NB, "rect"); await T.tap(page, NB, [500, 600]); return (await T.items(page, NB)).length === 6; })());

section("selection, move, resize, delete");
await T.setTool(page, NB, "select");
await T.tap(page, NB, [180, 320]);                                          // top edge of the rect
check("tap selects the rectangle", await T.panelState(page, NB, "p.selected") === 2);
const handles = await page.evaluate(() => { const p = dualnote.panels.nb; return JSON.parse(JSON.stringify(p.selInfo(p.items[p.selected], p.selected).pos)); });
check("rectangle shows 8 round handles", Object.keys(handles).length === 8);
await T.drag(page, NB, handles.se, [handles.se[0] + 40, handles.se[1] + 30]);
it = await T.items(page, NB);
check("dragging the corner handle resizes the rectangle", Math.abs(it[2].x2 - 300) < 3 && Math.abs(it[2].y2 - 430) < 3 && it[2].x1 === it[2].x1 && Math.abs(it[2].x1 - 100) < 1.5, JSON.stringify(it[2]));
await T.drag(page, NB, [180, 320], [200, 340]);                              // body drag = move
it = await T.items(page, NB);
check("dragging the border moves the rectangle", Math.abs(it[2].x1 - 120) < 2.5 && Math.abs(it[2].y1 - 340) < 2.5, JSON.stringify(it[2]));
await page.keyboard.press("Delete");
check("Delete key removes the selected item", (await T.items(page, NB)).length === 5);
await page.click('.panel[data-key="nb"] .btn[aria-label^="Undo"]');
await T.settle(page, 100);
check("undo brings it back", (await T.items(page, NB)).length === 6);
await page.click('.panel[data-key="nb"] .btn[aria-label^="Redo"]');
check("redo removes it again", (await T.items(page, NB)).length === 5);
await page.keyboard.press("Control+z"); await T.settle(page, 100);
check("Ctrl+Z works as a shortcut", (await T.items(page, NB)).length === 6);

section("eraser");
await T.setTool(page, NB, "eraser"); await T.drag(page, NB, [190, 160], [220, 180], 3);
it = await T.items(page, NB);
check("eraser removes the stroke it crosses (one undo step)", it.length === 5 && !it.some((i) => i.t === "pen"));
await page.keyboard.press("Control+z"); await T.settle(page, 100);
check("undo restores the erased stroke", (await T.items(page, NB)).some((i) => i.t === "pen"));

section("text and notes");
await T.setTool(page, NB, "text"); await T.tap(page, NB, [100, 540]);
check("tap with Text tool opens an editor", await page.$eval('.panel[data-key="nb"] textarea.editor', (t) => !t.hidden));
await page.fill('.panel[data-key="nb"] textarea.editor', "Hello نوشته فارسی");
await page.click('.panel[data-key="nb"] .stage', { position: { x: 20, y: 20 } });                      // tap elsewhere finishes the edit
await T.settle(page, 100);
it = await T.items(page, NB);
const tx = it.find((i) => i.t === "text");
check("text item created with the typed (mixed-direction) text", tx && tx.text === "Hello نوشته فارسی" && tx.size === 18, JSON.stringify(tx));
check("text is drawn (dark pixels at the text)", await page.evaluate(() => { const p = dualnote.panels.nb; p.draw(); const t = p.items.find((i) => i.t === "text");
  const d = p.ctx.getImageData(Math.round((p.view.tx + (t.x + 4) * p.view.scale) * p.dpr), Math.round((p.view.ty + (t.y + 4) * p.view.scale) * p.dpr), 160, 24).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 110) n++; return n > 40; }));
await T.setTool(page, NB, "select"); await T.tap(page, NB, [110, 550]); await T.tap(page, NB, [110, 550]);   // double tap edits
check("double-tap on text starts editing it", await page.$eval('.panel[data-key="nb"] textarea.editor', (t) => !t.hidden));
await page.fill('.panel[data-key="nb"] textarea.editor', "");
await page.click('.panel[data-key="nb"] .stage', { position: { x: 20, y: 20 } }); await T.settle(page, 100);
check("emptying a text box deletes it", !(await T.items(page, NB)).some((i) => i.t === "text"));
await T.setTool(page, NB, "note"); await T.tap(page, NB, [100, 560]);
await page.fill('.panel[data-key="nb"] textarea.editor', "Remember this " + "long ".repeat(60));
await page.click('.panel[data-key="nb"] .stage', { position: { x: 20, y: 20 } }); await T.settle(page, 100);
const note = (await T.items(page, NB)).find((i) => i.t === "note");
check("sticky note created, yellow paper, grows to fit its text", note && note.color === "#fff59d" && note.w === 190 && note.h > 140 && note.text.startsWith("Remember"), JSON.stringify(note));
check("note paper is drawn", await (async () => { const c = await T.pixelAt(page, NB, note.x + 170, note.y + 30); return c[0] > 235 && c[1] > 225 && c[2] < 200; })());
await T.tap(page, NB, [100, 560]);                                                                         // note tool: tap existing note edits it
check("tapping an existing note with the Note tool edits it", await page.$eval('.panel[data-key="nb"] textarea.editor', (t) => !t.hidden));
await page.click('.panel[data-key="nb"] .stage', { position: { x: 20, y: 20 } }); await T.settle(page, 100);
await T.setTool(page, NB, "select"); await T.tap(page, NB, [note.x + 95, note.y + 80]);
const nh = await page.evaluate(() => { const p = dualnote.panels.nb; return Object.keys(p.selInfo(p.items[p.selected], p.selected).pos).length; });
check("selected note has 8 handles", nh === 8);

check("no console errors during all of this", page.errors.length === 0, page.errors.join(" | "));
await browser.close(); server.close();
process.exit(T.summary() ? 1 : 0);
