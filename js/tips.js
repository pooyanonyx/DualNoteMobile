// Press-and-hold tooltips for touch / stylus input.
// Desktop mice keep the browser's own tooltip (the `title` attribute). A finger or pen cannot hover, so holding a toolbar
// button for a moment shows the same text (its title) in a small bubble next to it. A short tap works exactly as before;
// a hold only shows the bubble: the release does NOT click the button (so no tool is switched by accident).
const HOLD_MS = 480;          // press this long = "hold"
const MOVE_TOL = 10;          // moving more than this (px) before the bubble shows = it is a scroll / drag, not a hold
const AWAY_PX = 28;           // moving this far while the bubble is shown dismisses it
const LINGER_MS = 1300;       // the bubble stays a moment after the finger is lifted, so it can be read
const SEL = "button[title], select[title], [role='button'][title]";

let tip = null, timer = 0, hideTimer = 0, st = null, suppress = null;

function find(e) {
  const hit = e.target && e.target.closest ? e.target.closest(SEL) : null;
  const el = hit || (document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.matches && n.matches(SEL)) : null);
  return el && !el.closest(".stage") ? el : null;               // never on the page area: drawing there must not be touched
}
function textOf(el) {
  const title = (el.getAttribute("title") || "").trim(), label = (el.getAttribute("aria-label") || "").trim();
  if (!title && !label) return null;
  if (!label || !title || label === title || title.toLowerCase().startsWith(label.toLowerCase())) return { name: title || label, desc: "" };
  return { name: label, desc: title };
}
function hide(now = false) {
  clearTimeout(hideTimer);
  if (!tip) return;
  const t = tip; tip = null;
  if (st && st.el) st.el.removeAttribute("aria-describedby");
  t.classList.remove("show");
  setTimeout(() => t.remove(), now ? 0 : 140);
}
function show(el) {
  hide(true);
  const tx = textOf(el);
  if (!tx) return false;
  const t = document.createElement("div");
  t.className = "touchtip"; t.id = "touchtip"; t.setAttribute("role", "tooltip");
  const name = document.createElement("b"); name.textContent = tx.name; t.append(name);
  if (tx.desc) { const d = document.createElement("span"); d.textContent = tx.desc; t.append(d); }
  document.body.append(t);
  const r = el.getBoundingClientRect(), w = t.offsetWidth, h = t.offsetHeight, vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight, m = 8;
  let top = r.top - h - 10;                                       // above the button (the finger covers the button itself)
  if (top < m) top = r.bottom + 14;                               // no room above (toolbars sit at the top): below, clear of the fingertip
  top = Math.max(m, Math.min(top, vh - h - m));
  const left = Math.max(m, Math.min(r.left + r.width / 2 - w / 2, vw - w - m));
  t.style.left = left + "px"; t.style.top = top + "px";
  el.setAttribute("aria-describedby", "touchtip");
  requestAnimationFrame(() => t.classList.add("show"));
  tip = t;
  return true;
}
const cancelTimer = () => { clearTimeout(timer); timer = 0; };

export function initTouchTips() {
  if (initTouchTips.done) return; initTouchTips.done = true;
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;                        // desktop: native hover tooltip
    cancelTimer();
    if (!e.isPrimary) { hide(true); st = null; return; }          // a second finger = a gesture, not a hold
    hide(true);
    const el = find(e);
    if (!el) { st = null; return; }
    st = { el, id: e.pointerId, x: e.clientX, y: e.clientY, shown: false };
    timer = setTimeout(() => { if (st && st.el === el) st.shown = show(el); }, HOLD_MS);
  }, true);
  document.addEventListener("pointermove", (e) => {
    if (!st || e.pointerId !== st.id) return;
    const d = Math.hypot(e.clientX - st.x, e.clientY - st.y);
    if (!st.shown) { if (d > MOVE_TOL) { cancelTimer(); st = null; } return; }      // it is a scroll / drag: no bubble
    if (d > AWAY_PX || find(e) !== st.el) { hide(); suppress = null; }                // moved off the button: dismiss, and the release will not click
  }, true);
  const up = (e) => {
    if (!st || e.pointerId !== st.id) return;
    cancelTimer();
    if (st.shown && e.type === "pointerup" && find(e) === st.el) suppress = { el: st.el, until: performance.now() + 700 };     // this release must not activate the button
    if (tip) { clearTimeout(hideTimer); hideTimer = setTimeout(() => hide(), LINGER_MS); }
    st = null;
  };
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", (e) => { if (st && e.pointerId === st.id) { cancelTimer(); hide(); st = null; suppress = null; } }, true);
  document.addEventListener("click", (e) => {                     // swallow the click that follows a hold
    if (suppress && performance.now() < suppress.until && suppress.el.contains(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
    suppress = null;
  }, true);
  document.addEventListener("contextmenu", (e) => { if ((st || tip || suppress) && find(e)) e.preventDefault(); }, true);   // long-press must not open the system menu
  document.addEventListener("scroll", () => { cancelTimer(); hide(true); }, true);
  window.addEventListener("blur", () => { cancelTimer(); hide(true); st = null; });
}
export const _tipState = () => ({ visible: !!tip, text: tip ? tip.textContent : null });
