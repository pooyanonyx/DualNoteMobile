// End-to-end tests, part 2: colours and brush, images and paste, text highlight.
import fs from "node:fs";
import * as T from "./lib.mjs";
const { check, section } = T;
const server = await T.startServer();
const browser = await T.launch();
const pdfFile = T.writeTmp("fixture.pdf", await T.makePdf(T.TMP + "/fixture.pdf"));
const page = await T.newApp(browser, { viewport: { width: 1280, height: 1150 } });
const NB = "nb", PD = "pdf";
const P = (k) => `.panel[data-key="${k}"]`;

section("colour palette and custom colour");
await T.setTool(page, NB, "rect");
await page.click(`${P(NB)} .btn[title="Choose a colour"]`);
check("palette popup has 40 colours", await page.$$eval(".popup .palette:not(.recent) .sw", (n) => n.length) === 40);
await page.click('.popup .sw[aria-label="#1976d2"]');
check("palette pick sets the pen group colour and the swatch dot", await T.panelState(page, NB, "p.curStyle.color") === "#1976d2"
  && await T.panelState(page, NB, "p.groups.draw.color") === "#1976d2");
await T.drag(page, NB, [100, 100], [200, 160]);
check("new shapes use the picked colour", (await T.items(page, NB)).at(-1).color === "#1976d2");
check("recent colours remembered", await T.panelState(page, NB, "p.recent[0]") === "#1976d2");
await page.click(`${P(NB)} .btn[title="Choose a colour"]`);
await page.click('.popup .btn.wide');                                           // Custom color…
check("custom colour dialog opens", await page.$(".dialog .cdlg") !== null);
await page.fill(".dialog input.hex", "#12ab34");
check("typing HEX updates the RGB fields", JSON.stringify(await page.$$eval('.dialog input[type=number]', (n) => n.map((i) => +i.value))) === "[18,171,52]");
await page.fill('.dialog input[type=number][aria-label="R value"]', "255");
check("changing RGB updates HEX", (await page.inputValue(".dialog input.hex")) === "#FFAB34", await page.inputValue(".dialog input.hex"));
await page.click(".dialog .btn.primary");
check("OK applies the custom colour", await T.panelState(page, NB, "p.curStyle.color") === "#ffab34");
await page.click(`${P(NB)} .btn[title="Choose a colour"]`); await page.click('.popup .btn.wide');
await page.fill(".dialog input.hex", "#abc");
check("3-digit HEX is understood", JSON.stringify(await page.$$eval('.dialog input[type=number]', (n) => n.map((i) => +i.value))) === "[170,187,204]");
await page.keyboard.press("Escape"); await T.settle(page, 100);
check("Esc cancels the dialog without changing the colour", await page.$(".dialog") === null && await T.panelState(page, NB, "p.curStyle.color") === "#ffab34");

section("brush: thickness, opacity, brightness (independent per tool)");
const slider = (label, v) => page.$eval(`.popup input[aria-label="${label}"]`, (s, v) => { s.value = v; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); }, v);
await T.setTool(page, NB, "pen");
await page.click(`${P(NB)} .btn[title^="Thickness"]`);
await slider("Thickness", 9); await slider("Opacity", 50); await slider("Brightness", 30);
const st = await T.panelState(page, NB, "p.curStyle");
check("sliders change the style (opacity % -> 0..255)", st.width === 9 && st.alpha === 128 && st.bright === 30, JSON.stringify(st));
await page.keyboard.press("Escape");
await T.drag(page, NB, [100, 250], [300, 250]);
const pen = (await T.items(page, NB)).at(-1);
check("new stroke stores thickness, opacity and brightness", pen.w === 9 && pen.alpha === 128 && pen.bright === 30, JSON.stringify(pen).slice(0, 140));
const pc = await T.pixelAt(page, NB, 200, 250);
// #ffab34 = (255,171,52); +30% brightness -> (255,196,113); 50% opacity over white paper -> (255,225,184)
check("opacity and brightness are really drawn (expected pixel 255,225,184)", Math.abs(pc[0] - 255) <= 2 && Math.abs(pc[1] - 225) <= 3 && Math.abs(pc[2] - 184) <= 3, pc.join());
await T.setTool(page, NB, "mark");
check("marker keeps its own settings (not the pen's)", await T.panelState(page, NB, "p.curStyle.alpha") === 110 && await T.panelState(page, NB, "p.curStyle.width") === 14);
await T.setTool(page, NB, "pen");
check("pen settings are remembered after switching tools", await T.panelState(page, NB, "p.curStyle.alpha") === 128);
await T.setTool(page, NB, "select"); await T.tap(page, NB, [200, 250]);
check("Select shows the selected item's own settings", await T.panelState(page, NB, "p.curStyle.width") === 9);
await page.click(`${P(NB)} .btn[title="Choose a colour"]`); await page.click('.popup .sw[aria-label="#388e3c"]');
const rec = (await T.items(page, NB)).at(-1);
check("colour change applies to the selected item only", rec.color === "#388e3c" && await T.panelState(page, NB, "p.groups.draw.color") === "#ffab34");
await page.click(`${P(NB)} .btn[title^="Thickness"]`); await slider("Opacity", 100);
check("opacity slider changes the selected item", (await T.items(page, NB)).at(-1).alpha === 255);
await page.keyboard.press("Escape");

section("images: paste, button, file");
const red = await T.pngDataUrl(page, 200, 100, "#ff0000");
await page.click(`${P(NB)} .stage`, { position: { x: 10, y: 10 } });          // make the notebook the active panel
await page.evaluate(async (url) => {
  const blob = await (await fetch(url)).blob(), dt = new DataTransfer();
  dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
  document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, red);
await page.waitForFunction(() => dualnote.panels.nb.items.some((i) => i.t === "image"));
await T.settle(page, 150);
let img = (await T.items(page, NB)).find((i) => i.t === "image");
const w = img.x2 - img.x1, h = img.y2 - img.y1;
check("Ctrl+V pastes a screenshot as an image item", img && Math.abs(w / h - 2) < 0.01 && img.x1 >= 0 && img.x2 <= 595 && img.y2 <= 842);
check("the image is stored as PNG and is selected with the Select tool active", atob(img.data.slice(0, 8)).startsWith("\x89PNG")
  && await T.panelState(page, NB, "p.tool") === "select" && await T.panelState(page, NB, "p.selected") !== null);
check("the pasted picture is visible (centre pixel red)", T.isRed(await T.pixelAt(page, NB, (img.x1 + img.x2) / 2, (img.y1 + img.y2) / 2)));
const handles = await page.evaluate(() => { const p = dualnote.panels.nb; return Object.keys(p.selInfo(p.items[p.selected], p.selected).pos).join(); });
check("image has 4 corner handles", handles === "nw,ne,se,sw", handles);
const se = await page.evaluate(() => { const p = dualnote.panels.nb; return p.selInfo(p.items[p.selected], p.selected).pos.se; });
await T.drag(page, NB, se, [se[0] + 60, se[1] + 5]);
img = (await T.items(page, NB)).find((i) => i.t === "image");
check("dragging a corner resizes the image keeping its proportions", Math.abs((img.x2 - img.x1) / (img.y2 - img.y1) - 2) < 0.02 && img.x2 - img.x1 > w + 30, `${img.x2 - img.x1}`);
await page.keyboard.press("Control+z"); await T.settle(page, 100);
check("undo of the resize", Math.abs((await T.items(page, NB)).find((i) => i.t === "image").x2 - img.x2) > 20);
await page.keyboard.press("Control+z"); await T.settle(page, 100);
check("undo of the paste removes the image", !(await T.items(page, NB)).some((i) => i.t === "image"));
const blue = await T.pngDataUrl(page, 120, 120, "#0000ff");
const bluePng = T.writeTmp("blue.png", Buffer.from(T.b64(blue), "base64"));
await page.setInputFiles(T.fileInput(NB, true), bluePng);
await page.waitForFunction(() => dualnote.panels.nb.items.some((i) => i.t === "image"));
await T.settle(page, 150);
img = (await T.items(page, NB)).find((i) => i.t === "image");
check("Image button / file picker inserts a picture", img && T.isBlue(await T.pixelAt(page, NB, (img.x1 + img.x2) / 2, (img.y1 + img.y2) / 2)));
await page.evaluate(async (url) => { const blob = await (await fetch(url)).blob(); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); }, red);
await page.click(`${P(NB)} .btn[aria-label^="Paste"]`);
await page.waitForFunction(() => dualnote.panels.nb.items.filter((i) => i.t === "image").length === 2, null, { timeout: 5000 });
check("the Paste button reads an image from the clipboard (Android-friendly)", true);
await page.evaluate(() => navigator.clipboard.writeText("text from the clipboard"));
await page.click(`${P(NB)} .btn[aria-label^="Paste"]`); await T.settle(page, 300);
check("the Paste button pastes plain text as a text box", (await T.items(page, NB)).some((i) => i.t === "text" && i.text === "text from the clipboard"));
await page.setInputFiles(T.fileInput(NB, true), T.writeTmp("junk.png", Buffer.from("not an image")));
await T.settle(page, 400);
check("a broken image file is refused politely (no item, no crash)", (await T.items(page, NB)).filter((i) => i.t === "image").length === 2 && page.errors.length === 0, page.errors.join("|"));

section("images on a PDF page, and 'Open a PDF first'");
await page.click(`${P(PD)} .btn[aria-label^="Paste"]`); await T.settle(page, 200);
check("pasting with no PDF open does nothing harmful", await T.panelState(page, PD, "p.pages.length") === 0);
await T.openPdf(page, PD, pdfFile);
await page.setInputFiles(T.fileInput(PD, true), bluePng);
await page.waitForFunction(() => dualnote.panels.pdf.items.some((i) => i.t === "image"));
const pi = (await T.items(page, PD))[0];
check("image on a PDF page is drawn on top of the PDF", T.isBlue(await T.pixelAt(page, PD, (pi.x1 + pi.x2) / 2, (pi.y1 + pi.y2) / 2)));

section("highlight text (PDF)");
await T.setTool(page, PD, "select"); await page.keyboard.press("Delete");
await T.setTool(page, PD, "hltext");
const words = await T.panelState(page, PD, "p.words && p.words.length");
check("words with positions were extracted from the PDF", words >= 8, words);
await T.drag(page, PD, [80, 95], [190, 95]);
const hls = (await T.items(page, PD)).filter((i) => i.t === "hl");
check("dragging across text creates whole-word highlights (one per line)", hls.length === 1 && hls[0].x1 >= 70 && hls[0].x1 <= 90 && hls[0].y1 < 100 && hls[0].y2 > 100 && hls[0].alpha === 100, JSON.stringify(hls));
const hc = await T.pixelAt(page, PD, (hls[0].x1 + hls[0].x2) / 2, hls[0].y1 + 2);
check("the highlight is translucent yellow over the page", hc[0] > 200 && hc[1] > 200 && hc[2] < 235, hc.join());
await T.drag(page, PD, [75, 98], [300, 128]);
check("a drag over two lines gives two line highlights", (await T.items(page, PD)).filter((i) => i.t === "hl").length === 3);
section("pictures that are still decoding appear by themselves (regression)");
const blue2 = await T.pngDataUrl(page, 64, 64, "#0000ff");
await page.evaluate(([b]) => { const p = dualnote.panels.nb;      // committed without waiting for the picture: it decodes afterwards
  p.setTool("select"); p.commit([{ t: "image", x1: 300, y1: 700, x2: 380, y2: 780, data: b.split(",")[1] }]); }, [blue2]);
await page.waitForFunction(() => { const p = dualnote.panels.nb; const x = Math.round((p.view.tx + 340 * p.view.scale) * p.dpr), y = Math.round((p.view.ty + 740 * p.view.scale) * p.dpr);
  const c = p.ctx.getImageData(x, y, 1, 1).data; return c[2] > 200 && c[0] < 60; }, null, { timeout: 5000 });
check("an image that was not decoded yet shows up as soon as it is ready", true);
check("no console errors", page.errors.length === 0, page.errors.join(" | "));
await browser.close(); server.close();
process.exit(T.summary() ? 1 : 0);
