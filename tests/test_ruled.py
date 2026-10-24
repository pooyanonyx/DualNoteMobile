"""End-to-end tests of writing on lined notebook pages, driven through the real UI in Chromium.
Ink is measured on rendered pixels: for text made of 'H' the bottom of a glyph row IS the baseline, and that must sit on a printed rule."""
import sys, json
from playwright.sync_api import sync_playwright
from harness import App, Checker, shot, dark_rows, clusters

C = Checker()
PITCH, TOP, LIFT, PAD = 24, 72, 1, 4
def lh_of(size): 
    import math
    return PITCH * max(1, math.ceil(size * 1.2 / PITCH - 1e-9))

def page_ink(app, items, paper, x0, x1, y0, y1, scale=4):
    """Render the page like the PDF export does (R.renderPage) and return [(top, bottom)] of dark-ink row clusters in page pt."""
    return app.ev("""async ([items, paper, x0, x1, y0, y1, scale]) => {
      const R = await import('/js/render.js'), M = await import('/js/model.js');
      const c = document.createElement('canvas'); R.renderPage(c, M.PAGE_W, M.PAGE_H, items, { paper, scale });
      const px0 = Math.floor(x0 * scale), px1 = Math.ceil(x1 * scale), py0 = Math.floor(y0 * scale), py1 = Math.ceil(y1 * scale);
      const w = px1 - px0, h = py1 - py0, img = c.getContext('2d').getImageData(px0, py0, w, h).data, out = []; let st = -1;
      for (let r = 0; r <= h; r++) { let n = 0; if (r < h) for (let k = 0; k < w; k++) { const i = (r * w + k) * 4; if (img[i] < 110 && img[i+1] < 110 && img[i+2] < 110) n++; }
        if (n > 0 && st < 0) st = r; if (n === 0 && st >= 0) { out.push([(py0 + st) / scale, (py0 + r) / scale]); st = -1; } }
      return out; }""", [items, paper, x0, x1, y0, y1, scale])

def new_text(app, x, y, lines, size=None):
    if size is not None: app.ev("(n) => noteflow.panels.nb.applyStyle('size', n, false)", size)
    app.ev("() => { const p = noteflow.panels.nb; p.setTool('text'); }")
    app.click_page(x, y); app.type_lines(lines); app.finish()
    its = app.items(); return its[-1]

def baselines_ok(app, it, nlines, tol=0.6, label=""):
    """All glyph rows of a ruled item stand on their rule (committed rendering, 4x)."""
    lh = lh_of(it["size"]); top = it["y"] + PAD
    cl = page_ink(app, [it], "lined", it["x"] + PAD, it["x"] + PAD + 60, it["y"] - 4, it["y"] + nlines * lh + 4)
    exp = [top + (i + 1) * lh - LIFT for i in range(nlines)]
    got = [b for (_, b) in cl]
    ok = len(got) == nlines and all(abs(g - e) <= tol for g, e in zip(got, exp)) and all(abs((e + LIFT - TOP) % PITCH) < 1e-6 for e in exp)
    C.check("baselines on rules " + label, ok, "expected %s got %s" % ([round(e, 2) for e in exp], [round(g, 2) for g in got]))
    return cl

with sync_playwright() as pw:
    a = App(pw)

    # ---- 1. default size: many lines with Enter, one text box
    it = new_text(a, 100, 100, ["HHHHHHHH"] * 12, size=18)
    C.check("new text on lined page is ruled", it.get("ruled") is True and it["size"] == 18, {k: it[k] for k in ("y", "ruled", "size")})
    C.check("item top is on the rule lattice", abs((it["y"] + PAD - TOP) % PITCH) < 1e-6)
    baselines_ok(a, it, 12, label="(18pt, 12 lines in ONE box)")

    # ---- 2. many sizes, tap in the middle of a row and near its top / bottom
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; p.render(); }")
    for size in (8, 12, 16, 20, 21, 28, 36, 48, 72):
        a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; }")
        it = new_text(a, 80, 130, ["HHHH"] * 3, size=size)
        baselines_ok(a, it, 3, label="(size %d, lh %d)" % (size, lh_of(size)))
        C.check("size %d: line pitch is a whole number of rules" % size, lh_of(size) % PITCH == 0 and lh_of(size) >= size * 1.2 - 1e-6)

    # ---- 3. tap anywhere inside a row -> text in that row (not the row above / below)
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; }")
    rows = []
    for tapy in (97, 108, 119):                         # all inside the row between rule 96 and rule 120
        a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; }")
        it = new_text(a, 80, tapy, ["HH"], size=18); rows.append(it["y"] + PAD)
    C.check("taps in one row all give the same row", len(set(rows)) == 1 and rows[0] == 96, rows)
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; }")
    it = new_text(a, 80, 60, ["HH"], size=18)           # in the strip above the first rule: first line stands on the first printed rule
    C.check("tap above the first rule -> first printed rule", abs(it["y"] + PAD + lh_of(18) - TOP) < 1e-6, it["y"])
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; }")

    # ---- 4. editing overlay (what is on screen while typing) lines up with the rules
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; p.applyStyle('size', 18, false); p.setTool('text'); }")
    a.click_page(100, 100); a.type_lines(["HHH", "HHH", "HHH", "HHH", "HHH"])
    def overlay_check(label, tol=1.0):
        info = a.ev("""() => { const p = noteflow.panels.nb, ta = p.ta, r = p.stage.getBoundingClientRect(), d = p.editedItem(), v = p.view, s = v.scale, [ox, oy] = p.origin(),
          R = null; const ar = ta.getBoundingClientRect();
          return { d, v, ox, oy, rect: [ar.left, ar.top, ar.width, ar.height], stage: [r.left, r.top], scrollTop: ta.scrollTop, sh: ta.scrollHeight, ch: ta.clientHeight, lh: parseFloat(getComputedStyle(ta).lineHeight) }; }""")
        d = info["d"]; s = info["v"]["scale"]; lh = lh_of(d["size"]); top = d["y"] + PAD
        n = len(a.ev("() => noteflow.panels.nb.ta.value.split('\\n')"))
        left, ttop, wd, ht = info["rect"]
        img = shot(a, clip={"x": left + 1, "y": ttop + 1, "width": min(30 * s, wd - 2), "height": ht - 2})
        cl = clusters(dark_rows(img))
        exp = [info["stage"][1] + info["v"]["ty"] + (info["oy"] + top + (i + 1) * lh - LIFT) * s - (ttop + 1) for i in range(n)]
        got = [b for (_, b) in cl]
        errs = [round(g - e, 2) for g, e in zip(got, exp)]
        C.check("overlay baselines on rules " + label, len(got) == n and all(abs(x) <= tol for x in errs) and info["scrollTop"] == 0 and info["sh"] <= info["ch"] + 1,
                "css-px errors per line %s, scale %.3f, scrollTop %s" % (errs, s, info["scrollTop"]))
        return info
    overlay_check("(5 lines, fit zoom)")
    a.finish()

    # ---- 5. overlay while zooming and scrolling
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; p.setTool('text'); }")
    a.click_page(100, 100); a.type_lines(["HHH", "HHH", "HHH"])
    for f in (1.3, 0.8, 1.6):
        a.ev("(f) => noteflow.panels.nb.zoomBy(f)", f)
        a.page.wait_for_timeout(100)
        sc = a.ev("() => noteflow.panels.nb.view.scale")
        overlay_check("(zoom %.2f)" % sc, tol=1.0)
    a.ev("() => noteflow.panels.nb.scrollViewBy(0, 35)"); a.page.wait_for_timeout(80); overlay_check("(scrolled down)")
    a.ev("() => noteflow.panels.nb.scrollViewBy(0, -20)"); a.page.wait_for_timeout(80); overlay_check("(scrolled up)")
    a.page.keyboard.type("x"); a.page.keyboard.press("Enter"); a.page.keyboard.type("HHH")      # keep typing after zoom / scroll
    overlay_check("(typed after zoom+scroll, more lines)")
    a.finish()
    a.ev("() => { const p = noteflow.panels.nb; p.zoomBy(1); p.view.fit = true; p.onResize(); }")

    # ---- 6. text does not move when the editor closes (overlay vs committed canvas, same screen pixels)
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; p.setTool('text'); }")
    a.click_page(100, 100); a.type_lines(["HHHHHHHH", "HHHHHHHH", "HHHHHHHH"])
    info = a.ev("() => { const p = noteflow.panels.nb, ar = p.ta.getBoundingClientRect(); return [ar.left, ar.top, ar.width, ar.height]; }")
    clip = {"x": info[0] + 2, "y": info[1] + 2, "width": 120, "height": info[3] - 4}
    before = clusters(dark_rows(shot(a, clip=clip)))
    a.finish()
    after = clusters(dark_rows(shot(a, clip=clip)))
    d = [round(x[1] - y[1], 2) for x, y in zip(before, after)]
    C.check("no jump when the editor closes", len(before) == len(after) == 3 and all(abs(x) <= 1.0 for x in d), "bottom shift (css px) %s" % d)

    # ---- 7. persian + english, rtl: overlay baseline unaffected by the fallback font
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; p.setTool('text'); p.setFmt({dir:'ltr', align:'left'}); }")
    a.click_page(100, 100); a.type_lines(["HHH سلام دنیا", "HHH hello", "HHH متن فارسی و English"])
    overlay_check("(mixed Persian/English lines)")
    a.finish()
    it = a.items()[-1]
    C.check("mixed text stays ruled with 3 lines", it.get("ruled") is True)
    cl = page_ink(a, [it], "lined", it["x"] + PAD, it["x"] + PAD + 40, it["y"] - 4, it["y"] + 3 * 24 + 4)
    C.check("mixed text: leading H of every line on its rule", len(cl) == 3 and all(abs((b + LIFT - TOP) % 24) < 0.6 or abs((b + LIFT - TOP) % 24 - 24) < 0.6 for _, b in cl), [round(b, 2) for _, b in cl])

    # ---- 8. change font size of existing text: top row stays, lines stay on rules
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; }")
    it = new_text(a, 100, 150, ["HHHH", "HHHH", "HHHH"], size=18)
    top0 = it["y"] + PAD
    for newsize in (30, 12, 44, 18):
        a.ev("""(n) => { const p = noteflow.panels.nb; p.setTool('select'); p.selected = p.items.length - 1; p.applyStyle('size', n, true); }""", newsize)
        it = a.items()[-1]
        C.check("size -> %d keeps first row" % newsize, it["size"] == newsize and abs(it["y"] + PAD - top0) < 1e-6, it["y"] + PAD)
        baselines_ok(a, it, 3, label="(after size change to %d)" % newsize)
    a.ev("() => { noteflow.panels.nb.selected = null; }")

    # ---- 9. move by dragging snaps to rows; resize keeps lines on rules
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; }")
    it = new_text(a, 100, 150, ["HHHH", "HHHH"], size=18)
    a.ev("() => { const p = noteflow.panels.nb; p.setTool('select'); }")
    bx = a.ev("""() => { const p = noteflow.panels.nb; const b = p.geom(0); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }""")
    sx, sy = a.screen_of(*bx); sc = a.ev("() => noteflow.panels.nb.view.scale")
    a.page.mouse.move(sx, sy); a.page.mouse.down(); a.page.mouse.move(sx + 20, sy + 7.3 * sc, steps=6); a.page.mouse.move(sx + 25, sy + 31.7 * sc, steps=6); a.page.mouse.up()
    a.page.wait_for_timeout(150)
    it = a.items()[0]
    C.check("dragged text sits on the lattice", abs((it["y"] + PAD - TOP) % PITCH) < 1e-6 and it["x"] > 100, {k: it[k] for k in ("x", "y")})
    baselines_ok(a, it, 2, label="(after drag)")
    # resize with a corner handle (scales the text)
    hp = a.ev("""() => { const p = noteflow.panels.nb; p.selected = 0; p.render(); const d = p.items[0], b = p.geom(0), e = p.selInfo(d, 0).e; const hs = M_handles(d, b, e); return hs; function M_handles(d, b, e) { const x1 = b[2] + e, y1 = b[3] + e; return { se: [x1, y1] }; } }""")
    sx, sy = a.screen_of(*hp["se"])
    a.page.mouse.move(sx, sy); a.page.mouse.down(); a.page.mouse.move(sx + 60, sy + 70, steps=8); a.page.mouse.up(); a.page.wait_for_timeout(150)
    it = a.items()[0]
    C.check("resize changed the size and the item is still on the lattice", it["size"] != 18 and abs((it["y"] + PAD - TOP) % PITCH) < 1e-6, {k: it[k] for k in ("x", "y", "size")})
    baselines_ok(a, it, 2, label="(after resize to %.1f)" % it["size"])

    # ---- 10. editing existing ruled text: add lines in the middle, still aligned; undo / redo
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; p.selected = null; }")
    it = new_text(a, 100, 150, ["HHHH", "HHHH"], size=18)
    a.ev("() => { const p = noteflow.panels.nb; p.setTool('text'); p.startEdit(0); }")
    a.page.keyboard.press("Control+Home"); a.page.keyboard.press("End"); a.page.keyboard.press("Enter"); a.page.keyboard.type("HHHH"); a.page.keyboard.press("Enter"); a.page.keyboard.type("HHHH")
    overlay_check("(editing an existing box, 4 lines)")
    a.finish()
    it = a.items()[0]
    C.check("existing text edited: now 4 lines", it["text"].count("\n") == 3 and it.get("ruled") is True)
    baselines_ok(a, it, 4, label="(existing box edited)")
    a.ev("() => { const p = noteflow.panels.nb; p.undo(); }"); C.check("undo restores the 2-line text", a.items()[0]["text"].count("\n") == 1)
    a.ev("() => { const p = noteflow.panels.nb; p.redo(); }"); C.check("redo restores the 4-line text", a.items()[0]["text"].count("\n") == 3)

    # ---- 11. old text (no ruled flag) is moved onto the lines when edited; untouched when only opened
    legacy = {"t": "text", "x": 100, "y": 203.37, "w": 300, "dir": "ltr", "align": "left", "text": "HHHH\nHHHH", "color": "#1a1a1a", "size": 18}
    a.ev("(it) => { const p = noteflow.panels.nb; p.pages[p.cur].items = [it]; p.selected = null; p.render(); }", legacy)
    a.ev("() => { const p = noteflow.panels.nb; p.setTool('text'); p.startEdit(0); }"); a.page.keyboard.press("Escape"); a.page.wait_for_timeout(100)
    C.check("opening old text and leaving without a change leaves it alone", a.items()[0] == legacy)
    a.ev("() => { const p = noteflow.panels.nb; p.startEdit(0); }"); a.page.keyboard.press("Control+End"); a.page.keyboard.type("HH"); a.finish()
    it = a.items()[0]
    C.check("old text edited -> put on the lines", it.get("ruled") is True and abs((it["y"] + PAD - TOP) % PITCH) < 1e-6 and it["text"].endswith("HH"), {k: it[k] for k in ("y", "ruled")})
    baselines_ok(a, it, 2, label="(old text after an edit)")

    # ---- 12. snap button / free placement
    vis = a.ev("() => !noteflow.panels.nb.snapBtn.hidden && !noteflow.panels.nb.fmtGroup.hidden")
    C.check("snap button visible with the text tool on lined paper", vis)
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; p.selected = null; p.setTool('text'); }")
    a.page.click("section[data-key='nb'] .snapbtn-placeholder", timeout=300) if False else a.ev("() => noteflow.panels.nb.snapBtn.click()")
    it = new_text(a, 100, 203, ["HHH", "HHH"], size=18)
    C.check("snapping off: free text on lined paper keeps the old layout", it.get("ruled") is False and abs(it["y"] - (203 - 18 * 0.7)) < 0.01, {k: it.get(k) for k in ("y", "ruled")})
    a.ev("() => noteflow.panels.nb.snapBtn.click()")           # back on
    st = a.ev("() => noteflow.panels.nb.snapLines")
    C.check("snap toggles back on", st is True)

    # ---- 13. other surfaces are untouched
    for paper in ("blank", "grid"):
        a.ev("(pp) => { const p = noteflow.panels.nb; p.pages[p.cur].paper = pp; p.pages[p.cur].items = []; p.selected = null; p.setTool('text'); p.render(); p.fmtKey = ''; p.updateFmtUi(); }", paper)
        hidden = a.ev("() => noteflow.panels.nb.snapBtn.hidden")
        it = new_text(a, 100, 203, ["HHH", "HHH"], size=18)
        C.check("%s page: normal text (no ruled flag, old placement)" % paper, "ruled" not in it and abs(it["y"] - (203 - 18 * 0.7)) < 0.01 and hidden, {k: it.get(k) for k in ("y", "ruled")})
        lhs = a.ev("""async (it) => { const R = await import('/js/render.js'); return R.layoutText(R.measureCtx(), it.text, it.size, 292, null, false).lh; }""", it)
        C.check("%s page: line pitch is still 1.25 x size" % paper, abs(lhs - 22.5) < 1e-9, lhs)
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].paper = 'lined'; p.pages[p.cur].items = []; p.render(); }")

    # ---- 14. save + reopen the workspace: same pixels, ruled flag kept, setting kept
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; p.selected = null; p.setTool('text'); }")
    new_text(a, 100, 100, ["HHHH", "HHHH", "HHHH"], size=18)
    new_text(a, 150, 300, ["HHHH", "HHHH"], size=36)
    a.ev("() => { noteflow.panels.nb.setSnap(false); noteflow.panels.nb.setSnap(false); }")
    ref = a.ev("""async () => { const R = await import('/js/render.js'), M = await import('/js/model.js'); const p = noteflow.panels.nb, c = document.createElement('canvas');
      R.renderPage(c, M.PAGE_W, M.PAGE_H, p.pages[0].items, { paper: 'lined', scale: 2 }); return [c.toDataURL().length, c.toDataURL().slice(-400), JSON.stringify(p.pages[0].items)]; }""")
    ok = a.ev("""async () => {
      const WS = await import('/js/workspace.js'), M = await import('/js/model.js'); const blob = await WS.writeWorkspace(noteflow.collect());
      const ws = await WS.readWorkspace(blob); await noteflow.restore(ws); return true; }""")
    after = a.ev("""async () => { const R = await import('/js/render.js'), M = await import('/js/model.js'); const p = noteflow.panels.nb, c = document.createElement('canvas');
      R.renderPage(c, M.PAGE_W, M.PAGE_H, p.pages[0].items, { paper: 'lined', scale: 2 }); return [c.toDataURL().length, c.toDataURL().slice(-400), JSON.stringify(p.pages[0].items), p.snapLines]; }""")
    canon = lambda j: json.dumps(json.loads(j), sort_keys=True)
    C.check("workspace round trip: items identical (ruled flag kept)", canon(ref[2]) == canon(after[2]) and '"ruled":true' in after[2], "")
    C.check("workspace round trip: rendering identical", ref[0] == after[0] and ref[1] == after[1])
    C.check("workspace round trip: snap setting restored", after[3] is False, after[3])
    a.ev("() => noteflow.panels.nb.setSnap(true)")

    # ---- 15. notebook PDF export draws the same lines
    pdf_ok = a.ev("""async () => { const PD = await import('/js/pdfio.js'), p = noteflow.panels.nb; const bytes = await PD.exportNotebookPdf(p.pages.map(q => ({ paper: q.paper, items: q.items }))); return bytes.length; }""")
    C.check("PDF export works with ruled text", pdf_ok > 1000, pdf_ok)

    # ---- 16. a long note: 40 lines, no drift at the end
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; p.selected = null; p.setTool('text'); }")
    a.ev("() => noteflow.panels.nb.applyStyle('size', 14, false)")
    it = new_text(a, 90, 60, ["HHHH"] * 31, size=14)
    baselines_ok(a, it, 31, label="(31 lines, 14pt: every printed rule of the page)")

    print("page errors:", a.errors)
    C.check("no page errors", not a.errors, a.errors)
    ok = C.summary()
    sys.exit(0 if ok else 1)
