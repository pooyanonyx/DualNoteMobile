"""Shared helpers: start Chromium on the local static server, drive the real UI, and measure rendered pixels."""
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8765/index.html"
CHROME = None   # None = the Chromium that Playwright installed; or set a path to a Chromium binary

class App:
    def __init__(self, pw, width=1400, height=900, dpr=1, url=URL):
        self.browser = pw.chromium.launch(**({"executable_path": CHROME} if CHROME else {}), args=["--no-sandbox"])
        self.ctx = self.browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=dpr)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.on("console", lambda m: self.errors.append("console." + m.type + ": " + m.text) if m.type == "error" else None)
        self.page.goto(url); self.page.wait_for_timeout(1200)
        self.page.evaluate("async () => { await noteflow.setLayout(['nb'], false); }")
        self.page.wait_for_timeout(400)
        self.page.evaluate("() => { const p = noteflow.panels.nb; p.setTool('text'); }")

    def ev(self, js, arg=None):
        return self.page.evaluate(js, arg) if arg is not None else self.page.evaluate(js)

    def screen_of(self, x, y):
        """Page point (current page of the nb panel) -> viewport pixel."""
        return self.ev("""([x, y]) => { const p = noteflow.panels.nb, r = p.stage.getBoundingClientRect(), [sx, sy] = p.pageToScreen(x, y); return [r.left + sx, r.top + sy]; }""", [x, y])

    def click_page(self, x, y):
        sx, sy = self.screen_of(x, y)
        self.page.mouse.click(sx, sy)
        self.page.wait_for_timeout(120)

    def type_lines(self, lines, delay=0):
        for i, ln in enumerate(lines):
            if i: self.page.keyboard.press("Enter")
            if ln: self.page.keyboard.type(ln, delay=delay)
        self.page.wait_for_timeout(120)

    def finish(self):
        self.page.keyboard.press("Escape"); self.page.wait_for_timeout(150)
        self.ev("() => { const p = noteflow.panels.nb; p.selected = null; p.render(); }")

    def items(self):
        return self.ev("() => noteflow.panels.nb.pages[noteflow.panels.nb.cur].items")

    def ink_clusters(self, x0, x1, y0, y1, dark=110):
        """Rows (page pt) where dark ink pixels begin/end inside a page-space region of the main canvas -> list of (top, bottom)."""
        return self.ev("""([x0, x1, y0, y1, dark]) => {
          const p = noteflow.panels.nb, v = p.view, s = v.scale, dpr = p.dpr, [ox, oy] = p.origin();
          const px0 = Math.max(0, Math.floor((v.tx + (ox + x0) * s) * dpr)), px1 = Math.min(p.canvas.width, Math.ceil((v.tx + (ox + x1) * s) * dpr));
          const py0 = Math.max(0, Math.floor((v.ty + (oy + y0) * s) * dpr)), py1 = Math.min(p.canvas.height, Math.ceil((v.ty + (oy + y1) * s) * dpr));
          const w = px1 - px0, h = py1 - py0; if (w <= 0 || h <= 0) return [];
          const img = p.ctx.getImageData(px0, py0, w, h).data, rows = [];
          for (let r = 0; r < h; r++) { let n = 0; for (let c = 0; c < w; c++) { const i = (r * w + c) * 4; if (img[i] < dark && img[i+1] < dark && img[i+2] < dark) n++; } rows.push(n); }
          const out = []; let start = -1;
          for (let r = 0; r <= h; r++) {
            const on = r < h && rows[r] > 0;
            if (on && start < 0) start = r;
            if (!on && start >= 0) { out.push([((py0 + start) / dpr - v.ty) / s - oy, ((py0 + r) / dpr - v.ty) / s - oy]); start = -1; }
          }
          return out; }""", [x0, x1, y0, y1, dark])

def nearest_rule(y, top=72, pitch=24):
    j = round((y - top) / pitch)
    return top + j * pitch

def fresh(pw, **kw):
    return App(pw, **kw)


# ---------------------------------------------------------------- pixel helpers on page screenshots (what the user really sees)
import io
from PIL import Image
import numpy as np

def shot(app, clip=None):
    png = app.page.screenshot(clip=clip) if clip else app.page.screenshot()
    return np.array(Image.open(io.BytesIO(png)).convert("RGB")).astype(int)

def dark_rows(img, dark=110):
    m = (img[:, :, 0] < dark) & (img[:, :, 1] < dark) & (img[:, :, 2] < dark)
    return m.sum(axis=1)

def clusters(rows):
    out, start = [], None
    for i, n in enumerate(list(rows) + [0]):
        if n > 0 and start is None: start = i
        if n == 0 and start is not None: out.append((start, i)); start = None
    return out

class Checker:
    def __init__(self): self.results = []
    def check(self, name, ok, detail=""):
        self.results.append((name, bool(ok), detail)); print(("PASS " if ok else "FAIL ") + name + (("  -> " + str(detail)) if detail != "" else ""))
    def summary(self):
        bad = [r for r in self.results if not r[1]]
        print("\n%d checks, %d failed" % (len(self.results), len(bad)))
        return not bad
