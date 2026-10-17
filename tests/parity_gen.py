"""Generate random test cases from the Python model (model.py of the Windows app) so that the
JavaScript port can be checked against it:  python3 parity_gen.py > /tmp/parity.json"""
import json, random, sys
sys.path.insert(0, "../../DualNote")
import model as M

random.seed(20261015)
R = random.random
def rnd(a, b): return round(a + (b - a) * R(), 2)
def hexcol(): return "#%02x%02x%02x" % (random.randrange(256), random.randrange(256), random.randrange(256))
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="

def extras(d):
    if R() < .5: d["alpha"] = random.choice([0, 30, 110, 255, 300, -4])
    if R() < .5: d["bright"] = random.choice([-100, -50, -33, 0, 25, 50, 100, 250])
    return d

def item():
    t = random.choice(["pen", "mark", "line", "arrow", "rect", "ellipse", "hl", "text", "note", "image"])
    if t in ("pen", "mark"):
        return extras({"t": t, "pts": [[rnd(0, 500), rnd(0, 700)] for _ in range(random.randint(1, 6))], "color": hexcol(), "w": rnd(1, 20)})
    if t in ("line", "arrow", "rect", "ellipse"):
        return extras({"t": t, "x1": rnd(0, 500), "y1": rnd(0, 700), "x2": rnd(0, 500), "y2": rnd(0, 700), "color": hexcol(), "w": rnd(1, 12)})
    if t == "hl":
        return extras({"t": t, "x1": rnd(0, 500), "y1": rnd(0, 700), "x2": rnd(0, 500), "y2": rnd(0, 700), "color": hexcol()})
    if t == "text":
        return extras({"t": t, "x": rnd(0, 500), "y": rnd(0, 700), "text": "hi", "color": hexcol(), "size": rnd(6, 80)})
    if t == "note":
        return extras({"t": t, "x": rnd(0, 400), "y": rnd(0, 600), "w": rnd(30, 300), "h": rnd(20, 300), "text": "n", "color": hexcol(), "size": rnd(6, 30)})
    return extras({"t": "image", "x1": rnd(0, 400), "y1": rnd(0, 600), "x2": rnd(0, 400), "y2": rnd(0, 600), "data": PNG})

def junk():
    base = item()
    kind = random.choice(["missing", "badcolor", "badnum", "notdict", "unknown", "emptypts", "badpng"])
    if kind == "notdict": return "x"
    if kind == "unknown": return {"t": "zzz"}
    if kind == "emptypts": return {"t": "pen", "pts": [], "color": "#112233", "w": 2}
    if kind == "badpng": return {"t": "image", "x1": 0, "y1": 0, "x2": 5, "y2": 5, "data": "QUJDREVGR0hJSktMTU5PUA=="}
    d = dict(base)
    key = random.choice([k for k in d if k != "t"])
    if kind == "missing": del d[key]
    elif kind == "badcolor": d["color"] = random.choice(["red", "#12", "#gggggg", 5]) if "color" in d else d.get("color")
    else: d[key] = random.choice(["abc", None, [], {}]) if key not in ("data", "text", "color") else d[key]
    return d

def text_box(d):
    return [d["x"], d["y"], d["x"] + rnd(20, 200), d["y"] + rnd(10, 60)]

cases = []
for _ in range(400):
    d = item() if R() < .7 else junk()
    cases.append({"op": "sanitize", "item": d, "expected": M.sanitize_item(d)})
for _ in range(400):
    d = item()
    cases.append({"op": "effective_rgba", "item": d, "expected": list(M.effective_rgba(d))})
for _ in range(400):
    d = item()
    if d["t"] == "text": continue
    x, y = rnd(-20, 520), rnd(-20, 720)
    cases.append({"op": "hit_test", "item": d, "x": x, "y": y, "tol": rnd(0, 12), "expected": M.hit_test(d, x, y, 0) if False else None})
    cases[-1]["expected"] = M.hit_test(d, x, y, cases[-1]["tol"])
for _ in range(300):
    d = item()
    tb = text_box(d) if d["t"] == "text" else None
    cases.append({"op": "geom", "item": d, "tbox": tb, "expected": {
        "geom": list(M.geom_box(d, tb)), "half": M.half_width(d),
        "names": M.handle_names(d), "handles": {k: list(v) for k, v in M.handle_positions(d, M.geom_box(d, tb), 3.0 + M.half_width(d)).items()}}})
    cases.append({"op": "translate", "item": d if d["t"] != "text" else d, "dx": rnd(-50, 50), "dy": rnd(-50, 50)})
    cases[-1]["expected"] = M.translate(d, cases[-1]["dx"], cases[-1]["dy"])
for _ in range(900):
    d = item()
    tb = text_box(d) if d["t"] == "text" else None
    names = M.handle_names(d)
    h = random.choice(names)
    e = rnd(0, 8)
    px, py = rnd(-50, 600), rnd(-50, 800)
    ka = R() < .3
    cases.append({"op": "resize", "item": d, "handle": h, "px": px, "py": py, "tbox": tb, "e": e, "keep": ka,
                  "expected": M.resize_item(d, h, px, py, tb, e, ka)})
for _ in range(200):
    cols = [(random.randrange(256), random.randrange(256), random.randrange(256)) for _ in range(1)]
    cases.append({"op": "hex", "rgb": list(cols[0]), "expected": M.to_hex(*cols[0])})
for v in ["#FF8000", "ff8000", "#f80", "", "#", "#12", "#1234", "#12345g", "red", "#+12345", "#1234567", " #abc "]:
    cases.append({"op": "parse_hex", "text": v, "expected": M.parse_hex(v) and list(M.parse_hex(v))})
for v in [["pdf", "nb"], ["nb", "pdf"], ["nb", "nb2"], ["pdf", "pdf2"], ["pdf", "pdf"], ["pdf"], [], None, "x", ["pdf", "nb", "nb2"], ["pdf2", "x"]]:
    cases.append({"op": "layout", "value": v, "expected": M.sanitize_layout(v)})
for view in ["left", "both", "right", "pdf", "notebook", "zzz"]:
    for order in (["pdf", "nb"], ["nb", "pdf"], ["nb", "nb2"], ["pdf", "pdf2"]):
        cases.append({"op": "view", "view": view, "order": order, "expected": M.normalize_view(view, order)})
json.dump(cases, sys.stdout)
