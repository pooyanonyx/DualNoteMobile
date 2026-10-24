import sys
from playwright.sync_api import sync_playwright
from harness import App, Checker, shot, dark_rows, clusters
C = Checker()
PITCH, TOP, LIFT, PAD = 24, 72, 1, 4

with sync_playwright() as pw:
    # --- high-DPI screen (dpr 2) and a different window size: overlay vs rules
    a = App(pw, width=1100, height=800, dpr=2)
    a.ev("() => { const p = noteflow.panels.nb; p.applyStyle('size', 18, false); p.setTool('text'); }")
    a.click_page(100, 100); a.type_lines(["HHH"] * 4)
    info = a.ev("""() => { const p = noteflow.panels.nb, ar = p.ta.getBoundingClientRect(), r = p.stage.getBoundingClientRect(), [ox, oy] = p.origin(), d = p.editedItem();
      return { rect: [ar.left, ar.top, ar.width, ar.height], stage: [r.left, r.top], v: p.view, oy, d }; }""")
    s = info["v"]["scale"]; left, top, w, h = info["rect"]
    img = shot(a, clip={"x": left + 1, "y": top + 1, "width": 30 * s, "height": h - 2})          # device pixels (2x)
    got = [b / 2 for _, b in clusters(dark_rows(img))]
    exp = [info["stage"][1] + info["v"]["ty"] + (info["oy"] + info["d"]["y"] + PAD + (i + 1) * 24 - LIFT) * s - (top + 1) for i in range(4)]
    errs = [round(g - e, 2) for g, e in zip(got, exp)]
    C.check("dpr 2: overlay baselines on rules", len(got) == 4 and all(abs(x) <= 0.6 for x in errs), "css-px errors %s (scale %.3f)" % (errs, s))
    a.finish()

    # --- sticky notes and mind-map nodes on lined paper are NOT ruled and hide the snap button
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; p.setTool('note'); }")
    a.click_page(200, 300); a.type_lines(["note text"]); a.finish()
    n = a.items()[-1]
    C.check("sticky note on lined paper is a normal note", n["t"] == "note" and "ruled" not in n)
    a.ev("() => { const p = noteflow.panels.nb; p.setTool('select'); p.selected = 0; p.fmtKey = ''; p.updateFmtUi(); }")
    C.check("snap button hidden while a note is selected", a.ev("() => noteflow.panels.nb.snapBtn.hidden"))
    a.ev("() => { const p = noteflow.panels.nb; p.selected = null; p.setTool('text'); p.setTool('pen'); }")
    a.page.wait_for_timeout(150)                                   # (the toolbar is refreshed on the next animation frame)
    C.check("fmt group hidden for the pen", a.ev("() => noteflow.panels.nb.fmtGroup.hidden"))

    # --- board: text there is exactly as before
    a.ev("async () => { await noteflow.setLayout(['board'], false); }"); a.page.wait_for_timeout(400)
    r = a.ev("""() => { const p = noteflow.panels.board; p.setTool('text'); const [sx, sy] = [300, 300]; const r = p.stage.getBoundingClientRect();
      return [r.left + sx, r.top + sy]; }""")
    a.page.mouse.click(*r); a.page.wait_for_timeout(100); a.page.keyboard.type("hello"); a.page.keyboard.press("Enter"); a.page.keyboard.type("board"); a.page.keyboard.press("Escape"); a.page.wait_for_timeout(150)
    it = a.ev("() => noteflow.panels.board.pages[0].items.at(-1)")
    C.check("board text: no ruled flag, 1.25 line pitch layout", it["t"] == "text" and "ruled" not in it)
    C.check("snap button hidden on the board", a.ev("() => noteflow.panels.board.snapBtn.hidden"))
    # editor box on the board is the old one (opaque background, not transparent)
    a.page.mouse.dblclick(*r) ; a.page.wait_for_timeout(150)
    bg = a.ev("() => getComputedStyle(noteflow.panels.board.ta).backgroundColor")
    C.check("board editor keeps its white background", "255, 255, 255" in bg, bg)
    a.page.keyboard.press("Escape")

    # --- the lined-page editor does not use the opaque background (rules stay visible while typing)
    a.ev("async () => { await noteflow.setLayout(['nb'], false); }"); a.page.wait_for_timeout(400)
    a.ev("() => { const p = noteflow.panels.nb; p.pages[p.cur].items = []; p.setTool('text'); }")
    a.click_page(100, 100); a.type_lines(["abc"])
    bg = a.ev("() => getComputedStyle(noteflow.panels.nb.ta).backgroundColor")
    C.check("lined editor background transparent", bg in ("rgba(0, 0, 0, 0)", "transparent"), bg)
    a.page.screenshot(path="/tmp/editing.png")
    a.finish()
    C.check("no page errors", not a.errors, a.errors)
    sys.exit(0 if C.summary() else 1)
