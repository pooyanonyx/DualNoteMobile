// Keyboard shortcuts: ONE table used by the key handler, the tooltips and the shortcut list (so they can never disagree).
export const IS_MAC = /Mac|iPhone|iPad/i.test((typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)) || "");
export const MOD = IS_MAC ? "⌘" : "Ctrl";                       // label of the command key on this platform

/** Single-key tool shortcuts. Only tools the active panel has are switched to (e.g. U works in a PDF, O / L on a board). */
export const TOOL_KEYS = { select: "V", pan: "H", pen: "P", mark: "M", eraser: "E", text: "T", note: "N", shape: "S", hltext: "U", node: "O", link: "L" };
export const TOOL_BY_KEY = Object.fromEntries(Object.entries(TOOL_KEYS).map(([tool, k]) => [k.toLowerCase(), tool]));
export const FILL_KEY = "F";
export const hint = (text, key) => (key ? `${text} (${key})` : text);

/**
 * Name of the pressed key that does not depend on the keyboard layout: letters / digits use the printed character when it is
 * Latin, otherwise (Persian, Arabic, Cyrillic ... layouts) the physical key, so Ctrl+Z, P, V ... also work while typing Persian.
 */
export function keyName(e) {
  const k = e.key || "";
  if (k.length === 1) { const l = k.toLowerCase(); if (/^[a-z0-9]$/.test(l)) return l; }
  const c = e.code || "";
  if (/^Key[A-Z]$/.test(c)) return c[3].toLowerCase();
  if (/^(Digit|Numpad)[0-9]$/.test(c)) return c[c.length - 1];
  if (c === "Equal" || c === "NumpadAdd") return "+";
  if (c === "Minus" || c === "NumpadSubtract") return "-";
  if (c === "Period") return ".";
  if (c === "Slash") return e.shiftKey ? "?" : "/";
  if (c === "Space") return " ";
  return k;
}

/** Is this element something the user types into (or otherwise owns the keyboard)? */
export function isTextField(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || t.isContentEditable === true;
}
/** A keyboard-focused button / link: Enter and Space must activate it, not be used as shortcuts. */
export function isFocusedControl(t) {
  if (!t || !t.closest) return false;
  const c = t.closest("button, a[href], [role='button'], [role='tab'], [role='menuitem'], [role='menuitemradio']");
  if (!c) return false;
  try { return c.matches(":focus-visible"); } catch { return true; }
}

/** The shortcut reference (dialog opened with "?"). [label, keys] */
export const SHORTCUT_GROUPS = [
  ["Tools (when you are not typing)", [
    ["Select", "V"], ["Hand (move the view)", "H"], ["Pen", "P"], ["Marker", "M"], ["Eraser", "E"], ["Text", "T"], ["Note", "N"], ["Shapes", "S"],
    ["Fill on / off (shapes, nodes)", "F"], ["Highlight text (PDF)", "U"], ["Node (board)", "O"], ["Link (board)", "L"]]],
  ["Hold for a moment", [["Hand tool while the key is held, then back to your tool", "Space"]]],
  ["Edit", [
    ["Undo", `${MOD}+Z`], ["Redo", `${MOD}+Shift+Z  /  ${MOD}+Y`], ["Delete the selected item", "Delete"], ["Deselect / close a menu", "Esc"],
    ["Finish typing in a text box", `Esc  /  ${MOD}+Enter`], ["Board: child node / sibling node", "Tab  /  Enter"], ["Board: edit text, delete branch", "F2  /  Shift+Delete"]]],
  ["View", [
    ["Zoom in / out / fit", "+  /  -  /  0"], ["Scroll", "Arrow keys"], ["Scroll a screen up / down", "Page Up / Page Down"],
    ["First / last page (board: fit all)", "Home / End"], ["Previous / next page", "Alt+Left / Alt+Right"], ["Show / hide the toolbars", `${MOD}+.`]]],
  ["Workspace", [["Save workspace", `${MOD}+S`], ["Go to panel 1, 2, 3", "Alt+1 / 2 / 3"], ["This list", "?"]]],
];
