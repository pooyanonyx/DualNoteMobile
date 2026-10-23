// NoteFlow workspace file (.dnws): the whole session in ONE file - a ZIP archive with the same layout
// as the Windows app writes, so workspaces open in both apps:
//   manifest.json, settings.json, notebook.json, [notebook2.json], [board.json, board2.json],
//   pdf/original.pdf + pdf/annotations.json, [pdf2/...]
import * as M from "./model.js";

export const WORKSPACE_FORMAT = "DualNote-workspace";
export const WORKSPACE_VERSION = 1;
export const EXT = ".dnws";

export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const toBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

async function pdfInfo(p) {
  const src = toBytes(p.source);
  return { name: String(p.name || "document.pdf"), sha256: await sha256Hex(src), size: src.length, pages: p.pages.length };
}

/** pdf/pdf2: null or {name, source: Uint8Array, pages: [[item,...],...]}; notebooks: [{paper, items}] ; returns a Blob. */
export async function writeWorkspace({ pdf = null, pdf2 = null, notebook = null, notebook2 = null, board = null, board2 = null, settings = {}, type = null }) {
  const JSZip = globalThis.JSZip;
  const manifest = {
    format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, app: "NoteFlow (web)",
    saved: new Date().toISOString(),
    pdf: pdf ? await pdfInfo(pdf) : null, pdf2: pdf2 ? await pdfInfo(pdf2) : null,
    notebook_pages: notebook ? notebook.length : null, notebook2_pages: notebook2 ? notebook2.length : null,
    board_items: board ? board.items.length : null, board2_items: board2 ? board2.items.length : null,
  };
  if (type) manifest.workspace_type = type;            // pdf | notebook | pdf+notebook | notebook+pdf (panels left to right)
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("settings.json", JSON.stringify(settings));
  if (notebook) zip.file("notebook.json", M.notebookToJson(notebook));      // a PDF-only workspace has no notebook
  if (notebook2) zip.file("notebook2.json", M.notebookToJson(notebook2));
  if (board) zip.file("board.json", M.boardToJson(board));                  // boards: one file each, only for the panels the workspace has
  if (board2) zip.file("board2.json", M.boardToJson(board2));
  for (const [prefix, p] of [["pdf", pdf], ["pdf2", pdf2]]) {
    if (!p) continue;
    zip.file(`${prefix}/original.pdf`, toBytes(p.source), { compression: "STORE" });   // PDFs are already compressed
    zip.file(`${prefix}/annotations.json`, M.pdfAnnotationsToJson(p.pages));
  }
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/** Read and fully validate a workspace (ArrayBuffer/Uint8Array/Blob). Throws Error with a readable message. */
export async function readWorkspace(data) {
  const JSZip = globalThis.JSZip;
  let zip;
  try { zip = await JSZip.loadAsync(data); } catch { throw new Error("This is not a valid NoteFlow workspace file."); }
  const need = async (name, type = "string") => {
    const f = zip.file(name);
    if (!f) throw new Error(`The workspace file is incomplete (missing ${name}).`);
    return f.async(type);
  };
  let manifest;
  try { manifest = JSON.parse(await need("manifest.json")); } catch (e) {
    if (e.message.startsWith("The workspace")) throw e;
    throw new Error("The workspace manifest is unreadable.");
  }
  if (!manifest || manifest.format !== WORKSPACE_FORMAT) throw new Error("This is not a NoteFlow workspace file.");
  if (!Number.isInteger(manifest.version) || manifest.version < 1) throw new Error("The workspace has an invalid version number.");
  if (manifest.version > WORKSPACE_VERSION) {
    throw new Error(`This workspace was saved by a newer version of NoteFlow (file version ${manifest.version}, this app reads up to ${WORKSPACE_VERSION}). Please update NoteFlow.`);
  }
  let settings = {};
  try { const s = JSON.parse(await need("settings.json")); if (s && typeof s === "object" && !Array.isArray(s)) settings = s; } catch (e) {
    if (e.message.startsWith("The workspace")) throw e;
  }
  const type = M.layoutOfType(manifest.workspace_type) || manifest.workspace_type === "custom" ? manifest.workspace_type : null;      // absent in older files
  const hasNb = !type || (type !== "custom" && M.layoutOfType(type).includes("nb"));
  const notebook = hasNb || zip.file("notebook.json") ? M.parseNotebook(await need("notebook.json")) : null;
  const notebook2 = zip.file("notebook2.json") ? M.parseNotebook(await need("notebook2.json")) : null;
  const board = zip.file("board.json") ? M.parseBoard(await need("board.json")) : null;
  const board2 = zip.file("board2.json") ? M.parseBoard(await need("board2.json")) : null;
  const loadPdf = async (prefix, info) => {
    if (!info || typeof info !== "object") throw new Error("The workspace manifest is corrupt.");
    const source = await need(`${prefix}/original.pdf`, "uint8array");
    if ((await sha256Hex(source)) !== info.sha256) throw new Error("The embedded PDF does not match its checksum; the workspace is damaged.");
    const pages = M.parsePdfAnnotations(await need(`${prefix}/annotations.json`), info.pages);
    if (!pages) throw new Error("The PDF annotation data in the workspace is damaged.");
    return { name: String(info.name || "document.pdf"), source, pages };
  };
  const pdf = manifest.pdf != null ? await loadPdf("pdf", manifest.pdf) : null;
  const pdf2 = manifest.pdf2 != null ? await loadPdf("pdf2", manifest.pdf2) : null;
  return { manifest, settings, notebook, notebook2, board, board2, pdf, pdf2, type };
}
