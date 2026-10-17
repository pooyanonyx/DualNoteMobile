// Checks that model.js gives the same answers as the Python model on thousands of random cases.
import fs from "node:fs";
import * as M from "../www/js/model.js";
const cases = JSON.parse(fs.readFileSync(process.argv[2] || "/tmp/parity.json", "utf8"));
const EPS = 0.0151;       // Python rounds half-to-even on binary floats; JS differs by one hundredth at most
function same(a, b, path = "") {
  if (a === null || b === null || a === undefined || b === undefined) return a == b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= EPS ? null : `${path}: ${a} vs ${b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const r = same(a[i], b[i], `${path}[${i}]`); if (r) return r; }
    return null;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (JSON.stringify(ka) !== JSON.stringify(kb)) return `${path}: keys ${ka} vs ${kb}`;
    for (const k of ka) { const r = same(a[k], b[k], `${path}.${k}`); if (r) return r; }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}
let bad = 0, hitMismatch = 0;
const byOp = {};
for (const c of cases) {
  let got;
  switch (c.op) {
    case "sanitize": got = M.sanitizeItem(c.item); break;
    case "effective_rgba": got = M.effectiveRgba(c.item); break;
    case "hit_test": got = M.hitTest(c.item, c.x, c.y, c.tol); break;
    case "geom": { const tb = c.tbox; const g = M.geomBox(c.item, tb); got = { geom: g, half: M.halfWidth(c.item), names: M.handleNames(c.item),
      handles: M.handlePositions(c.item, g, 3 + M.halfWidth(c.item)) }; break; }
    case "translate": got = M.translate(c.item, c.dx, c.dy); break;
    case "resize": got = M.resizeItem(c.item, c.handle, c.px, c.py, c.tbox, c.e, c.keep); break;
    case "hex": got = M.toHex(...c.rgb); break;
    case "parse_hex": got = M.parseHex(c.text); break;
    case "layout": got = M.sanitizeLayout(c.value); break;
    case "view": got = M.normalizeView(c.view, c.order); break;
    default: throw new Error("unknown op " + c.op);
  }
  const diff = same(got, c.expected);
  byOp[c.op] = byOp[c.op] || { n: 0, bad: 0 };
  byOp[c.op].n++;
  if (diff) {
    if (c.op === "hit_test") { hitMismatch++; byOp[c.op].bad++; if (hitMismatch <= 3) console.log("hit_test mismatch near the tolerance edge?", JSON.stringify(c).slice(0, 200)); continue; }
    bad++; byOp[c.op].bad++;
    if (bad <= 8) console.log("MISMATCH", c.op, diff, "\n   ", JSON.stringify(c).slice(0, 300));
  }
}
console.log(Object.entries(byOp).map(([k, v]) => `${k}: ${v.n - v.bad}/${v.n}`).join("  "));
console.log(bad === 0 && hitMismatch === 0 ? "PARITY OK" : `PARITY FAILED (${bad} mismatches, ${hitMismatch} hit-test)`);
process.exit(bad === 0 && hitMismatch === 0 ? 0 : 1);
