/* ==========================================================================
   Éditeur PDF — vanilla JS, rendu avec pdf.js, export avec pdf-lib
   ========================================================================== */

const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = PDFLib;

/* ------------------------------------------------------------------------ */
/* Configuration (sécurité / limites) — ajustez ces valeurs selon vos besoins */
/* ------------------------------------------------------------------------ */

const CONFIG = {
  MAX_FILE_SIZE_BYTES: 20 * 1024 * 1024, // 20 Mo
  MAX_PAGES: 500,                         // refuse les PDF avec plus de pages que ça
  LOAD_TIMEOUT_MS: 30000,                 // délai max pour ouvrir/analyser un PDF
  RENDER_TIMEOUT_MS: 30000,               // délai max pour rendre une page
  MAX_CANVAS_DIMENSION: 6000,             // px ; borne la taille de canvas quel que soit le zoom
};

/* ------------------------------------------------------------------------ */
/* Chargement vérifié du worker pdf.js (intégrité)                          */
/* ------------------------------------------------------------------------ */
// Le script principal pdf.js (chargé en <script type="module" integrity="...">
// dans index.html) est déjà protégé par une Subresource Integrity classique.
// Le *worker*, lui, est instancié dynamiquement via `new Worker(url)`, une API
// qui ne supporte pas l'attribut `integrity`. On vérifie donc son empreinte
// SHA-384 nous-mêmes avant de l'utiliser, et on refuse de démarrer si la
// vérification échoue (échec fermé : on ne charge jamais un worker non
// vérifié, même en cas d'erreur réseau).

const PDF_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs";
const PDF_WORKER_SHA384_B64 = "ZsWbdAW9R0tLHblpnT9OlTG0oDnOBndXJiKFJnsmzR2TXBm7oh5eDqIyTrxseosS";

async function setupVerifiedWorker() {
  if (!window.isSecureContext || !window.crypto || !window.crypto.subtle) {
    throw new Error("Contexte non sécurisé : cette application doit être servie en HTTPS.");
  }
  const res = await fetch(PDF_WORKER_URL);
  if (!res.ok) throw new Error("Téléchargement du worker PDF.js impossible (réseau).");
  const buf = await res.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-384", buf);
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  if (hashB64 !== PDF_WORKER_SHA384_B64) {
    throw new Error("Échec de la vérification d'intégrité du worker PDF.js.");
  }
  const blob = new Blob([buf], { type: "text/javascript" });
  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
}

const workerReady = setupVerifiedWorker();
workerReady.catch((err) => console.error("[sécurité] worker pdf.js non initialisé:", err));

/* ------------------------------------------------------------------------ */
/* State                                                                     */
/* ------------------------------------------------------------------------ */

const state = {
  fileName: "document",
  originalBytes: null,   // ArrayBuffer of the source PDF, kept intact
  pdfDoc: null,           // pdf.js document, used only for rendering
  pages: [],               // [{ key, sourceIndex, rotation, width, height }]
  annotations: {},         // key -> [annotation, ...]
  currentIndex: 0,         // index into state.pages
  zoom: 1,
  tool: "select",
  options: { color: "#000000", fontSize: 14, strokeWidth: 3 },
  selectedId: null,
  history: [],
  future: [],
  pendingImage: null,      // { dataUrl, width, height, mime } waiting to be placed
};

let keyCounter = 1;
const nextKey = () => "p" + keyCounter++;
let annCounter = 1;
const nextAnnId = () => "a" + annCounter++;

/* ------------------------------------------------------------------------ */
/* DOM references                                                           */
/* ------------------------------------------------------------------------ */

const el = {
  fileInput: document.getElementById("file-input"),
  imageInput: document.getElementById("image-input"),
  btnOpen: document.getElementById("btn-open"),
  btnOpenEmpty: document.getElementById("btn-open-empty"),
  btnSave: document.getElementById("btn-save"),
  btnUndo: document.getElementById("btn-undo"),
  btnRedo: document.getElementById("btn-redo"),
  btnZoomIn: document.getElementById("btn-zoom-in"),
  btnZoomOut: document.getElementById("btn-zoom-out"),
  zoomLabel: document.getElementById("zoom-label"),
  btnPrevPage: document.getElementById("btn-prev-page"),
  btnNextPage: document.getElementById("btn-next-page"),
  pageLabel: document.getElementById("page-label"),
  btnAddPage: document.getElementById("btn-add-page"),
  toolGroup: document.getElementById("tool-group"),
  toolOptions: document.getElementById("tool-options"),
  optColor: document.getElementById("opt-color"),
  optFontSize: document.getElementById("opt-fontsize"),
  optStrokeWidth: document.getElementById("opt-strokewidth"),
  viewer: document.getElementById("viewer"),
  emptyState: document.getElementById("empty-state"),
  pageScroll: document.getElementById("page-scroll"),
  pageWrap: document.getElementById("page-wrap"),
  canvas: document.getElementById("pdf-canvas"),
  layer: document.getElementById("annotation-layer"),
  thumbsList: document.getElementById("thumbnails-list"),
  toast: document.getElementById("toast"),
};

const ctx = el.canvas.getContext("2d");
let currentRenderTask = null;

/* ------------------------------------------------------------------------ */
/* Utilities                                                                 */
/* ------------------------------------------------------------------------ */

function hexToRgb01(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return rgb(0, 0, 0);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

function clone(obj) {
  if (typeof structuredClone === "function") return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

function currentPage() {
  return state.pages[state.currentIndex] || null;
}

/** Rotated on-screen dimensions (CSS px) for a page at the given scale. */
function rotatedDims(page, scale) {
  const w = page.width * scale, h = page.height * scale;
  return (page.rotation === 90 || page.rotation === 270) ? { width: h, height: w } : { width: w, height: h };
}

/** Pointer position (relative to the unrotated page-wrap box) -> PDF-space {x,y}. */
function pointerToPdf(mx, my, page, scale) {
  const W = page.width, H = page.height, s = scale;
  switch (page.rotation) {
    case 90: return { x: my / s, y: mx / s };
    case 180: return { x: W - mx / s, y: my / s };
    case 270: return { x: W - my / s, y: H - mx / s };
    default: return { x: mx / s, y: H - my / s };
  }
}

/** Never let the requested zoom push a canvas beyond CONFIG.MAX_CANVAS_DIMENSION px. */
function clampZoomForPage(zoom, page) {
  if (!page) return zoom;
  const maxZoom = CONFIG.MAX_CANVAS_DIMENSION / Math.max(page.width, page.height, 1);
  return Math.min(zoom, maxZoom);
}

/** Falls back to a sane default if a page's declared dimensions are missing/corrupt. */
function safePageDimension(pts, fallback) {
  return (Number.isFinite(pts) && pts > 0) ? pts : fallback;
}

/** Strips path separators/control characters so a file name is always safe to reuse
 *  (e.g. as a suggested download name) — defense in depth, no filesystem path is ever
 *  built from this value in this app. */
function sanitizeFileBaseName(name) {
  const base = String(name || "document").replace(/\.pdf$/i, "");
  const cleaned = base.replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_").trim().slice(0, 100);
  return cleaned || "document";
}

let toastTimer = null;
/** User-facing error/warning banner. Never pass raw error objects/stack traces here —
 *  only short, static, human-readable messages (see "Sécurité web" for why). */
function showError(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  requestAnimationFrame(() => el.toast.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 7000);
}

/** Rejects with an Error("TIMEOUT") after `ms`, calling `onTimeout` (e.g. to cancel/destroy
 *  the underlying pdf.js task) so the work doesn't keep running in the background. */
function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { onTimeout && onTimeout(); reject(new Error("TIMEOUT")); }, ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/** Reads only the first 1KB of the file to check for the "%PDF-" signature, without
 *  trusting the browser-reported MIME type or the file extension. */
async function hasPdfSignature(file) {
  const headSize = Math.min(1024, file.size);
  const bytes = new Uint8Array(await file.slice(0, headSize).arrayBuffer());
  return new TextDecoder("latin1").decode(bytes).includes("%PDF-");
}

/* ------------------------------------------------------------------------ */
/* History (undo / redo)                                                    */
/* ------------------------------------------------------------------------ */

function snapshot() {
  return { pages: clone(state.pages), annotations: clone(state.annotations) };
}

function pushHistory() {
  state.history.push(snapshot());
  if (state.history.length > 60) state.history.shift();
  state.future.length = 0;
  updateHistoryButtons();
}

function restore(snap) {
  state.pages = snap.pages;
  state.annotations = snap.annotations;
  if (state.currentIndex >= state.pages.length) state.currentIndex = Math.max(0, state.pages.length - 1);
  state.selectedId = null;
  renderThumbnails();
  renderPage();
  updateHistoryButtons();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(snapshot());
  restore(state.history.pop());
}

function redo() {
  if (!state.future.length) return;
  state.history.push(snapshot());
  restore(state.future.pop());
}

function updateHistoryButtons() {
  el.btnUndo.disabled = state.history.length === 0;
  el.btnRedo.disabled = state.future.length === 0;
}

/* ------------------------------------------------------------------------ */
/* Loading a PDF                                                            */
/* ------------------------------------------------------------------------ */

async function loadFile(file) {
  if (!file) return;

  // --- 1) Validation, before any parsing touches the (untrusted) file content ---
  if (file.size === 0) {
    showError("Le fichier est vide.");
    return;
  }
  if (file.size > CONFIG.MAX_FILE_SIZE_BYTES) {
    showError(
      `Fichier trop volumineux (${(file.size / 1024 / 1024).toFixed(1)} Mo). ` +
      `Taille maximale autorisée : ${(CONFIG.MAX_FILE_SIZE_BYTES / 1024 / 1024).toFixed(0)} Mo.`
    );
    return;
  }
  // Real signature check (magic number), never trust file.type or the .pdf extension alone.
  if (!(await hasPdfSignature(file))) {
    showError("Ce fichier ne semble pas être un PDF valide (signature %PDF- absente).");
    return;
  }

  try {
    await workerReady;
  } catch (err) {
    showError("Impossible de démarrer le moteur PDF en toute sécurité (vérification d'intégrité échouée). Rechargez la page.");
    return;
  }

  const buf = await file.arrayBuffer();
  let loadingTask;
  let pdfDoc;
  try {
    loadingTask = pdfjsLib.getDocument({
      data: buf.slice(0),
      isEvalSupported: false, // never execute eval-like code paths while parsing/rendering
    });
    pdfDoc = await withTimeout(loadingTask.promise, CONFIG.LOAD_TIMEOUT_MS, () => loadingTask.destroy());
  } catch (err) {
    console.error(err);
    if (loadingTask) { try { loadingTask.destroy(); } catch (e) { /* ignore */ } }
    if (err && err.message === "TIMEOUT") {
      showError("Ce PDF met trop de temps à s'ouvrir (fichier corrompu ou anormalement complexe) et a été abandonné.");
    } else {
      showError("Ce fichier n'a pas pu être ouvert : il est peut-être corrompu ou protégé par mot de passe.");
    }
    return;
  }

  // Structural sanity limit — also guards against pathological/oversized documents
  // ("PDF bombs": a small file that expands into an enormous number of pages/objects).
  if (pdfDoc.numPages > CONFIG.MAX_PAGES) {
    const n = pdfDoc.numPages;
    pdfDoc.destroy();
    showError(`Ce PDF contient ${n} pages ; la limite autorisée est de ${CONFIG.MAX_PAGES} pages.`);
    return;
  }

  // --- 2) Validation passed: adopt the new document ---
  if (state.pdfDoc) { try { state.pdfDoc.destroy(); } catch (e) { /* ignore */ } }

  state.fileName = sanitizeFileBaseName(file.name);
  state.originalBytes = buf;
  state.pdfDoc = pdfDoc;

  state.pages = [];
  state.annotations = {};
  state.history = [];
  state.future = [];
  state.selectedId = null;

  for (let i = 0; i < state.pdfDoc.numPages; i++) {
    const p = await state.pdfDoc.getPage(i + 1);
    const view = p.view; // [x0,y0,x1,y1] unrotated
    const key = nextKey();
    state.pages.push({
      key,
      sourceIndex: i,
      rotation: ((p.rotate % 360) + 360) % 360,
      width: safePageDimension(view[2] - view[0], 595.28),
      height: safePageDimension(view[3] - view[1], 841.89),
    });
    state.annotations[key] = [];
  }

  state.currentIndex = 0;
  el.emptyState.hidden = true;
  el.pageWrap.hidden = false;
  el.btnSave.disabled = false;
  el.btnAddPage.disabled = false;

  fitZoomToViewer();
  await renderThumbnails();
  await renderPage();
  updateHistoryButtons();
}

/* ------------------------------------------------------------------------ */
/* Rendering: main page                                                     */
/* ------------------------------------------------------------------------ */

async function renderPage() {
  const page = currentPage();
  if (!page) return;

  const dims = rotatedDims(page, state.zoom);
  // Cap the backing-store resolution too: on a high-DPR screen, width/height*dpr could
  // otherwise exceed MAX_CANVAS_DIMENSION even though the CSS size itself is within bounds.
  const dpr = Math.min(
    window.devicePixelRatio || 1,
    Math.max(1, CONFIG.MAX_CANVAS_DIMENSION / Math.max(dims.width, dims.height, 1))
  );

  el.pageWrap.style.width = dims.width + "px";
  el.pageWrap.style.height = dims.height + "px";
  el.canvas.style.width = dims.width + "px";
  el.canvas.style.height = dims.height + "px";
  el.canvas.width = Math.max(1, Math.round(dims.width * dpr));
  el.canvas.height = Math.max(1, Math.round(dims.height * dpr));

  if (currentRenderTask) { try { currentRenderTask.cancel(); } catch (e) { /* ignore */ } }

  if (page.sourceIndex != null) {
    const pjs = await state.pdfDoc.getPage(page.sourceIndex + 1);
    const viewport = pjs.getViewport({ scale: state.zoom, rotation: page.rotation });
    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
    const task = pjs.render({ canvasContext: ctx, viewport, transform });
    currentRenderTask = task;
    try {
      await withTimeout(task.promise, CONFIG.RENDER_TIMEOUT_MS, () => task.cancel());
    } catch (e) {
      if (e.name !== "RenderingCancelledException" && e.message !== "TIMEOUT") throw e;
      if (e.message === "TIMEOUT") showError("Le rendu de cette page prend trop de temps et a été interrompu.");
    }
    if (currentRenderTask === task) currentRenderTask = null;
  } else {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, dims.width, dims.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  el.layer.style.width = (page.width * state.zoom) + "px";
  el.layer.style.height = (page.height * state.zoom) + "px";
  el.layer.style.transform = `translate(-50%, -50%) rotate(${page.rotation}deg)`;

  renderAnnotations();
  updatePageLabel();
  updateZoomLabel();
}

function updatePageLabel() {
  el.pageLabel.textContent = state.pages.length
    ? `${state.currentIndex + 1} / ${state.pages.length}`
    : "0 / 0";
  el.btnPrevPage.disabled = state.currentIndex <= 0;
  el.btnNextPage.disabled = state.currentIndex >= state.pages.length - 1;
}

function updateZoomLabel() {
  el.zoomLabel.textContent = Math.round(state.zoom * 100) + "%";
}

function fitZoomToViewer() {
  const page = currentPage();
  if (!page) return;
  const availW = el.viewer.clientWidth - 60;
  const availH = el.viewer.clientHeight - 60;
  const baseW = (page.rotation === 90 || page.rotation === 270) ? page.height : page.width;
  const baseH = (page.rotation === 90 || page.rotation === 270) ? page.width : page.height;
  const scale = Math.min(availW / baseW, availH / baseH, 2);
  state.zoom = clampZoomForPage(Math.max(0.25, Math.round(scale * 100) / 100), page);
}

/* ------------------------------------------------------------------------ */
/* Rendering: annotation overlay                                            */
/* ------------------------------------------------------------------------ */

function renderAnnotations() {
  const page = currentPage();
  el.layer.innerHTML = "";
  if (!page) return;
  const list = state.annotations[page.key] || [];
  const scale = state.zoom;

  // SVG layer for freehand strokes (drawn first, behind other annotations)
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "draw-svg");
  svg.setAttribute("viewBox", `0 0 ${page.width * scale} ${page.height * scale}`);
  el.layer.appendChild(svg);

  for (const ann of list) {
    if (ann.type === "draw") {
      renderDrawAnnotation(ann, page, scale, svg);
      continue;
    }
    el.layer.appendChild(buildAnnotationEl(ann, page, scale));
  }
}

function drawBoundingBox(ann) {
  const xs = ann.points.map(p => p.x), ys = ann.points.map(p => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function renderDrawAnnotation(ann, page, scale, svg) {
  const svgNS = "http://www.w3.org/2000/svg";
  const pts = ann.points.map(pt => `${pt.x * scale},${(page.height - pt.y) * scale}`).join(" ");
  const selected = ann.id === state.selectedId;
  const pad = 6 / scale;
  const bbox = drawBoundingBox(ann);

  if (selected) {
    const box = document.createElementNS(svgNS, "rect");
    box.setAttribute("x", (bbox.minX - pad) * scale);
    box.setAttribute("y", (page.height - bbox.maxY - pad) * scale);
    box.setAttribute("width", (bbox.maxX - bbox.minX + pad * 2) * scale);
    box.setAttribute("height", (bbox.maxY - bbox.minY + pad * 2) * scale);
    box.setAttribute("fill", "none");
    box.setAttribute("stroke", "#4f46e5");
    box.setAttribute("stroke-width", 1.5);
    box.setAttribute("stroke-dasharray", "4 3");
    box.style.pointerEvents = "none";
    svg.appendChild(box);
  }

  // Wider, invisible hit-path layered over the visible stroke so thin lines stay easy to grab.
  const hit = document.createElementNS(svgNS, "polyline");
  hit.setAttribute("points", pts);
  hit.setAttribute("fill", "none");
  hit.setAttribute("stroke", "transparent");
  hit.setAttribute("stroke-width", Math.max(14, ann.strokeWidth * scale + 10));
  hit.setAttribute("stroke-linecap", "round");
  hit.setAttribute("stroke-linejoin", "round");
  hit.style.pointerEvents = "stroke";
  hit.style.cursor = "move";
  hit.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (state.tool !== "select") return;
    selectAnnotation(ann.id);
    startPointsDrag(e, ann, page);
  });
  svg.appendChild(hit);

  const pl = document.createElementNS(svgNS, "polyline");
  pl.setAttribute("points", pts);
  pl.setAttribute("fill", "none");
  pl.setAttribute("stroke", ann.color);
  pl.setAttribute("stroke-width", ann.strokeWidth * scale);
  pl.setAttribute("stroke-linecap", "round");
  pl.setAttribute("stroke-linejoin", "round");
  pl.style.pointerEvents = "none";
  svg.appendChild(pl);

  if (selected) {
    const del = document.createElement("div");
    del.className = "ann-delete";
    del.style.pointerEvents = "auto";
    del.style.right = "auto";
    del.style.left = ((bbox.maxX + pad) * scale) + "px";
    del.style.top = ((page.height - bbox.maxY - pad) * scale) + "px";
    del.style.transform = "translate(-50%, -50%)";
    del.textContent = "×";
    del.title = "Supprimer";
    del.addEventListener("pointerdown", (e) => { e.stopPropagation(); deleteAnnotation(ann.id, true); });
    el.layer.appendChild(del);
  }
}

function buildAnnotationEl(ann, page, scale) {
  const wrap = document.createElement("div");
  wrap.className = "ann ann-" + ann.type;
  wrap.dataset.id = ann.id;
  if (ann.id === state.selectedId) wrap.classList.add("selected");

  if (ann.type === "text") {
    wrap.style.left = (ann.x * scale) + "px";
    wrap.style.top = ((page.height - ann.topY) * scale) + "px";

    const inner = document.createElement("div");
    inner.className = "ann-text";
    inner.style.minWidth = "20px";
    inner.contentEditable = "true";
    inner.spellcheck = false;
    inner.style.font = `${ann.fontSize * scale}px sans-serif`;
    inner.style.color = ann.color;
    inner.style.lineHeight = "1.2";
    inner.textContent = ann.text;
    inner.addEventListener("input", () => { ann.text = inner.textContent; });
    inner.addEventListener("pointerdown", (e) => { e.stopPropagation(); selectAnnotation(ann.id); });
    inner.addEventListener("blur", () => {
      if (!inner.textContent.trim()) deleteAnnotation(ann.id, false);
      else { pushHistory(); ann.text = inner.textContent; }
    });
    wrap.appendChild(inner);

    if (ann.id === state.selectedId) {
      requestAnimationFrame(() => inner.focus());
    }
  } else if (ann.type === "highlight" || ann.type === "rect" || ann.type === "image") {
    wrap.style.left = (ann.x * scale) + "px";
    wrap.style.top = ((page.height - ann.y - ann.height) * scale) + "px";
    wrap.style.width = (ann.width * scale) + "px";
    wrap.style.height = (ann.height * scale) + "px";
    if (ann.type === "highlight") {
      wrap.style.background = ann.color;
      wrap.style.opacity = "0.45";
    } else if (ann.type === "rect") {
      wrap.style.border = `${Math.max(1, ann.strokeWidth * scale)}px solid ${ann.color}`;
    } else if (ann.type === "image") {
      const img = document.createElement("img");
      img.src = ann.dataUrl;
      img.draggable = false;
      wrap.appendChild(img);
    }
    attachDragAndResize(wrap, ann, page, true);
  }

  if (ann.id === state.selectedId) {
    if (ann.type === "text") {
      const drag = document.createElement("div");
      drag.className = "ann-drag";
      drag.title = "Déplacer";
      drag.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 12.5V6a1.4 1.4 0 0 1 2.8 0v5.5M10.8 11V4.6a1.4 1.4 0 0 1 2.8 0V11M13.6 11.3V6.2a1.4 1.4 0 0 1 2.8 0v7.6c0 3.3-1.9 5.7-5.6 5.7h-.9c-1.9 0-2.9-.5-4-2l-2.1-2.9a1.3 1.3 0 0 1 1.9-1.8l1.3 1.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      drag.addEventListener("pointerdown", (e) => startFieldDrag(e, ann, page, "x", "topY"));
      wrap.appendChild(drag);
    }
    const del = document.createElement("div");
    del.className = "ann-delete";
    del.textContent = "×";
    del.title = "Supprimer";
    del.addEventListener("pointerdown", (e) => { e.stopPropagation(); deleteAnnotation(ann.id, true); });
    wrap.appendChild(del);
    if (ann.type !== "text" && ann.type !== "draw") {
      const rz = document.createElement("div");
      rz.className = "ann-resize";
      rz.addEventListener("pointerdown", (e) => startResize(e, ann, page));
      wrap.appendChild(rz);
    }
  }

  return wrap;
}

function selectAnnotation(id) {
  state.selectedId = id;
  renderAnnotations();
}

function deleteAnnotation(id, record) {
  const page = currentPage();
  if (!page) return;
  if (record) pushHistory();
  state.annotations[page.key] = state.annotations[page.key].filter(a => a.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  renderAnnotations();
}

/* ------------------------------------------------------------------------ */
/* Dragging & resizing annotations                                          */
/* ------------------------------------------------------------------------ */

/** Generic pointer-drag helper: moves ann[xKey]/ann[yKey] (PDF-space) to follow the pointer. */
function startFieldDrag(e, ann, page, xKey, yKey) {
  e.stopPropagation();
  e.preventDefault();
  pushHistory();
  const rect = el.pageWrap.getBoundingClientRect();
  const start = pointerToPdf(e.clientX - rect.left, e.clientY - rect.top, page, state.zoom);
  const dx = ann[xKey] - start.x, dy = ann[yKey] - start.y;
  const onMove = (ev) => {
    const cur = pointerToPdf(ev.clientX - rect.left, ev.clientY - rect.top, page, state.zoom);
    ann[xKey] = cur.x + dx;
    ann[yKey] = cur.y + dy;
    renderAnnotations();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/** Drag helper for freehand strokes: shifts every point by the pointer's delta. */
function startPointsDrag(e, ann, page) {
  e.stopPropagation();
  e.preventDefault();
  pushHistory();
  const rect = el.pageWrap.getBoundingClientRect();
  const start = pointerToPdf(e.clientX - rect.left, e.clientY - rect.top, page, state.zoom);
  const original = ann.points.map(p => ({ x: p.x, y: p.y }));
  const onMove = (ev) => {
    const cur = pointerToPdf(ev.clientX - rect.left, ev.clientY - rect.top, page, state.zoom);
    const dx = cur.x - start.x, dy = cur.y - start.y;
    ann.points = original.map(p => ({ x: p.x + dx, y: p.y + dy }));
    renderAnnotations();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function attachDragAndResize(wrap, ann, page, movable) {
  if (!movable) return;
  wrap.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("ann-resize") || e.target.classList.contains("ann-delete")) return;
    e.stopPropagation();
    if (state.tool !== "select") return;
    selectAnnotation(ann.id);
    startFieldDrag(e, ann, page, "x", "y");
  });
}

function startResize(e, ann, page) {
  e.stopPropagation();
  pushHistory();
  const rect = el.pageWrap.getBoundingClientRect();
  const left = ann.x;
  const top = ann.y + ann.height; // PDF-y of the box's top edge, stays fixed while resizing
  const onMove = (ev) => {
    const cur = pointerToPdf(ev.clientX - rect.left, ev.clientY - rect.top, page, state.zoom);
    const width = Math.max(8, cur.x - left);
    let height = top - cur.y;
    let y = cur.y;
    if (height < 8) { height = 8; y = top - 8; }
    ann.x = left;
    ann.width = width;
    ann.y = y;
    ann.height = height;
    renderAnnotations();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/* ------------------------------------------------------------------------ */
/* Tool interactions on the page-wrap (creating annotations)                */
/* ------------------------------------------------------------------------ */

let drawing = null;

el.pageWrap.addEventListener("pointerdown", (e) => {
  const page = currentPage();
  if (!page) return;
  if (e.target !== el.pageWrap && e.target !== el.canvas && !e.target.classList.contains("draw-svg")) return;

  const rect = el.pageWrap.getBoundingClientRect();
  const pdfPt = pointerToPdf(e.clientX - rect.left, e.clientY - rect.top, page, state.zoom);

  if (state.tool === "select") {
    state.selectedId = null;
    renderAnnotations();
    return;
  }

  if (state.tool === "text") {
    pushHistory();
    const ann = {
      id: nextAnnId(), type: "text",
      x: pdfPt.x, topY: pdfPt.y,
      fontSize: state.options.fontSize, color: state.options.color, text: "",
    };
    state.annotations[page.key].push(ann);
    state.selectedId = ann.id;
    renderAnnotations();
    return;
  }

  if (state.tool === "image") {
    if (!state.pendingImage) { el.imageInput.click(); return; }
    pushHistory();
    const img = state.pendingImage;
    const maxW = page.width * 0.5;
    const w = Math.min(maxW, img.width * 0.75);
    const h = w * (img.height / img.width);
    const ann = {
      id: nextAnnId(), type: "image",
      x: pdfPt.x - w / 2, y: pdfPt.y - h / 2, width: w, height: h,
      dataUrl: img.dataUrl, mime: img.mime,
    };
    state.annotations[page.key].push(ann);
    state.pendingImage = null;
    state.selectedId = ann.id;
    setTool("select");
    renderAnnotations();
    return;
  }

  if (state.tool === "draw") {
    pushHistory();
    drawing = {
      id: nextAnnId(), type: "draw",
      points: [pdfPt], color: state.options.color, strokeWidth: state.options.strokeWidth,
    };
    state.annotations[page.key].push(drawing);
    const onMove = (ev) => {
      const p = pointerToPdf(ev.clientX - rect.left, ev.clientY - rect.top, page, state.zoom);
      drawing.points.push(p);
      renderAnnotations();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      drawing = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return;
  }

  if (state.tool === "highlight" || state.tool === "rect") {
    pushHistory();
    const type = state.tool;
    const ann = {
      id: nextAnnId(), type,
      x: pdfPt.x, y: pdfPt.y, width: 0, height: 0,
      color: type === "highlight" ? state.options.color : state.options.color,
      strokeWidth: state.options.strokeWidth,
    };
    state.annotations[page.key].push(ann);
    const startX = pdfPt.x, startY = pdfPt.y;
    const onMove = (ev) => {
      const p = pointerToPdf(ev.clientX - rect.left, ev.clientY - rect.top, page, state.zoom);
      ann.x = Math.min(startX, p.x);
      ann.y = Math.min(startY, p.y);
      ann.width = Math.abs(p.x - startX);
      ann.height = Math.abs(p.y - startY);
      renderAnnotations();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (ann.width < 2 && ann.height < 2) deleteAnnotation(ann.id, false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
});

/* ------------------------------------------------------------------------ */
/* Thumbnails                                                                */
/* ------------------------------------------------------------------------ */

async function renderThumbnails() {
  el.thumbsList.innerHTML = "";
  const THUMB_W = 140;

  for (let i = 0; i < state.pages.length; i++) {
    const page = state.pages[i];
    const dims = rotatedDims(page, 1);
    const scale = THUMB_W / dims.width;
    const cdims = rotatedDims(page, scale);

    const item = document.createElement("div");
    item.className = "thumb" + (i === state.currentIndex ? " active" : "");
    item.draggable = true;
    item.dataset.index = i;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(cdims.width);
    canvas.height = Math.round(cdims.height);
    item.appendChild(canvas);

    const label = document.createElement("div");
    label.className = "thumb-index";
    label.textContent = i + 1;
    item.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "thumb-actions";
    actions.innerHTML = `
      <button data-act="rotate" title="Pivoter"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 1 2.7 6M4 12v5H9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button data-act="dup" title="Dupliquer"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>
      <button data-act="del" title="Supprimer"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    item.appendChild(actions);

    actions.querySelector('[data-act="rotate"]').addEventListener("click", (e) => { e.stopPropagation(); rotatePage(i); });
    actions.querySelector('[data-act="dup"]').addEventListener("click", (e) => { e.stopPropagation(); duplicatePage(i); });
    actions.querySelector('[data-act="del"]').addEventListener("click", (e) => { e.stopPropagation(); removePage(i); });

    item.addEventListener("click", () => { state.currentIndex = i; renderPage(); highlightActiveThumb(); });

    item.addEventListener("dragstart", (e) => {
      item.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
    });
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
    item.addEventListener("dragover", (e) => { e.preventDefault(); item.classList.add("drag-over"); });
    item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      item.classList.remove("drag-over");
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      const to = parseInt(item.dataset.index, 10);
      if (Number.isNaN(from) || from === to) return;
      movePage(from, to);
    });

    el.thumbsList.appendChild(item);

    if (page.sourceIndex != null) {
      state.pdfDoc.getPage(page.sourceIndex + 1).then(pjs => {
        const viewport = pjs.getViewport({ scale, rotation: page.rotation });
        const tctx = canvas.getContext("2d");
        pjs.render({ canvasContext: tctx, viewport });
      });
    } else {
      const tctx = canvas.getContext("2d");
      tctx.fillStyle = "#fff";
      tctx.fillRect(0, 0, canvas.width, canvas.height);
      tctx.strokeStyle = "#ddd";
      tctx.strokeRect(0, 0, canvas.width, canvas.height);
    }
  }
}

function highlightActiveThumb() {
  el.thumbsList.querySelectorAll(".thumb").forEach((t, i) => {
    t.classList.toggle("active", i === state.currentIndex);
  });
}

/* ------------------------------------------------------------------------ */
/* Page operations                                                          */
/* ------------------------------------------------------------------------ */

function rotatePage(i) {
  pushHistory();
  const page = state.pages[i];
  page.rotation = (page.rotation + 90) % 360;
  if (i === state.currentIndex) { state.selectedId = null; renderPage(); }
  renderThumbnails();
}

function duplicatePage(i) {
  pushHistory();
  const src = state.pages[i];
  const newKey = nextKey();
  const copy = { ...src, key: newKey };
  state.pages.splice(i + 1, 0, copy);
  state.annotations[newKey] = clone(state.annotations[src.key] || []).map(a => ({ ...a, id: nextAnnId() }));
  if (i < state.currentIndex) state.currentIndex++;
  renderThumbnails();
  renderPage();
}

function removePage(i) {
  if (state.pages.length <= 1) return;
  pushHistory();
  const [removed] = state.pages.splice(i, 1);
  delete state.annotations[removed.key];
  if (state.currentIndex >= state.pages.length) state.currentIndex = state.pages.length - 1;
  else if (i < state.currentIndex) state.currentIndex--;
  state.selectedId = null;
  renderThumbnails();
  renderPage();
}

function movePage(from, to) {
  pushHistory();
  const currentKey = state.pages[state.currentIndex].key;
  const [moved] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, moved);
  state.currentIndex = state.pages.findIndex(p => p.key === currentKey);
  renderThumbnails();
}

function addBlankPage() {
  pushHistory();
  const key = nextKey();
  const ref = currentPage();
  state.pages.splice(state.currentIndex + 1, 0, {
    key, sourceIndex: null, rotation: 0,
    width: ref ? ref.width : 595.28, height: ref ? ref.height : 841.89,
  });
  state.annotations[key] = [];
  state.currentIndex++;
  renderThumbnails();
  renderPage();
}

/* ------------------------------------------------------------------------ */
/* Tools & options UI                                                       */
/* ------------------------------------------------------------------------ */

function setTool(tool) {
  state.tool = tool;
  el.toolGroup.querySelectorAll(".tool-btn").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
  el.toolOptions.className = "";
  if (["text", "draw", "highlight", "rect"].includes(tool)) el.toolOptions.classList.add("show-color");
  if (tool === "text") el.toolOptions.classList.add("show-fontSize");
  if (["draw", "rect"].includes(tool)) el.toolOptions.classList.add("show-strokeWidth");
  el.pageWrap.style.cursor = tool === "select" ? "default" : "crosshair";
  // En mode select, le doigt doit pouvoir faire défiler/zoomer la page (geste tactile natif).
  // Dans tout autre mode, un glissé sur la page crée une annotation (texte, dessin,
  // surlignage, rectangle, image) : sans ceci, un doigt qui glisse fait défiler la page
  // au lieu de dessiner, car le navigateur intercepte le geste avant les pointerevents.
  el.pageWrap.style.touchAction = tool === "select" ? "auto" : "none";
}

el.toolGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".tool-btn");
  if (!btn) return;
  if (btn.dataset.tool === "image") { state.pendingImage = null; }
  setTool(btn.dataset.tool);
});

el.optColor.addEventListener("input", () => { state.options.color = el.optColor.value; });
el.optFontSize.addEventListener("input", () => { state.options.fontSize = parseInt(el.optFontSize.value, 10) || 16; });
el.optStrokeWidth.addEventListener("input", () => { state.options.strokeWidth = parseInt(el.optStrokeWidth.value, 10) || 3; });

el.imageInput.addEventListener("change", () => {
  const file = el.imageInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      state.pendingImage = {
        dataUrl: reader.result, width: img.naturalWidth, height: img.naturalHeight,
        mime: file.type,
      };
      el.pageWrap.style.cursor = "copy";
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
  el.imageInput.value = "";
});

/* ------------------------------------------------------------------------ */
/* Toolbar: open / save / zoom / navigation / undo-redo                    */
/* ------------------------------------------------------------------------ */

el.btnOpen.addEventListener("click", () => el.fileInput.click());
el.btnOpenEmpty.addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", () => {
  const file = el.fileInput.files[0];
  if (file) loadFile(file);
  el.fileInput.value = "";
});

el.btnSave.addEventListener("click", exportPdf);
el.btnUndo.addEventListener("click", undo);
el.btnRedo.addEventListener("click", redo);
el.btnAddPage.addEventListener("click", addBlankPage);

el.btnZoomIn.addEventListener("click", () => {
  const requested = Math.min(4, Math.round((state.zoom + 0.1) * 100) / 100);
  state.zoom = clampZoomForPage(requested, currentPage());
  renderPage();
});
el.btnZoomOut.addEventListener("click", () => {
  const requested = Math.max(0.2, Math.round((state.zoom - 0.1) * 100) / 100);
  state.zoom = clampZoomForPage(requested, currentPage());
  renderPage();
});

el.btnPrevPage.addEventListener("click", () => { if (state.currentIndex > 0) { state.currentIndex--; state.selectedId = null; renderPage(); highlightActiveThumb(); } });
el.btnNextPage.addEventListener("click", () => { if (state.currentIndex < state.pages.length - 1) { state.currentIndex++; state.selectedId = null; renderPage(); highlightActiveThumb(); } });

window.addEventListener("keydown", (e) => {
  const activeTag = document.activeElement && document.activeElement.tagName;
  const editing = document.activeElement && document.activeElement.isContentEditable;
  if (editing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
  else if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId && activeTag !== "INPUT") {
    e.preventDefault();
    deleteAnnotation(state.selectedId, true);
  }
});

window.addEventListener("resize", () => { if (currentPage()) renderPage(); });

/* Drag & drop a PDF onto the viewer */
["dragenter", "dragover"].forEach(evt => el.viewer.addEventListener(evt, (e) => {
  e.preventDefault();
  if ([...e.dataTransfer.items].some(it => it.type === "application/pdf")) el.viewer.classList.add("drag-active");
}));
["dragleave", "drop"].forEach(evt => el.viewer.addEventListener(evt, (e) => {
  e.preventDefault();
  el.viewer.classList.remove("drag-active");
}));
el.viewer.addEventListener("drop", (e) => {
  const file = [...e.dataTransfer.files].find(f => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (file) loadFile(file);
});

/* ------------------------------------------------------------------------ */
/* Export                                                                    */
/* ------------------------------------------------------------------------ */

async function exportPdf() {
  if (!state.originalBytes) return;
  el.btnSave.disabled = true;
  const originalLabel = el.btnSave.querySelector("span").textContent;
  el.btnSave.querySelector("span").textContent = "Export...";

  try {
    const srcDoc = await PDFDocument.load(state.originalBytes);
    const outDoc = await PDFDocument.create();
    const font = await outDoc.embedFont(StandardFonts.Helvetica);
    const imageCache = new Map();

    for (const page of state.pages) {
      let newPage;
      if (page.sourceIndex != null) {
        const [copied] = await outDoc.copyPages(srcDoc, [page.sourceIndex]);
        newPage = outDoc.addPage(copied);
      } else {
        newPage = outDoc.addPage([page.width, page.height]);
      }
      newPage.setRotation(degrees(page.rotation));

      const anns = state.annotations[page.key] || [];
      for (const ann of anns) {
        if (ann.type === "text") {
          if (!ann.text.trim()) continue;
          const lines = ann.text.split("\n");
          const firstBaseline = ann.topY - ann.fontSize * 0.85;
          lines.forEach((line, idx) => {
            newPage.drawText(line, {
              x: ann.x,
              y: firstBaseline - idx * ann.fontSize * 1.2,
              size: ann.fontSize,
              font,
              color: hexToRgb01(ann.color),
            });
          });
        } else if (ann.type === "rect") {
          newPage.drawRectangle({
            x: ann.x, y: ann.y, width: ann.width, height: ann.height,
            borderColor: hexToRgb01(ann.color), borderWidth: ann.strokeWidth,
          });
        } else if (ann.type === "highlight") {
          newPage.drawRectangle({
            x: ann.x, y: ann.y, width: ann.width, height: ann.height,
            color: hexToRgb01(ann.color), opacity: 0.45,
          });
        } else if (ann.type === "draw") {
          for (let i = 0; i < ann.points.length - 1; i++) {
            const a = ann.points[i], b = ann.points[i + 1];
            newPage.drawLine({
              start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y },
              thickness: ann.strokeWidth, color: hexToRgb01(ann.color), lineCap: LineCapStyle.Round,
            });
          }
        } else if (ann.type === "image") {
          let embedded = imageCache.get(ann.dataUrl);
          if (!embedded) {
            const isPng = ann.mime === "image/png" || ann.dataUrl.startsWith("data:image/png");
            embedded = isPng ? await outDoc.embedPng(ann.dataUrl) : await outDoc.embedJpg(ann.dataUrl);
            imageCache.set(ann.dataUrl, embedded);
          }
          newPage.drawImage(embedded, { x: ann.x, y: ann.y, width: ann.width, height: ann.height });
        }
      }
    }

    const bytes = await outDoc.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.fileName}-edite.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    console.error(err);
    showError("Une erreur est survenue lors de l'export du PDF.");
  } finally {
    el.btnSave.disabled = false;
    el.btnSave.querySelector("span").textContent = originalLabel;
  }
}

/* ------------------------------------------------------------------------ */
/* Popup "À propos"                                                          */
/* ------------------------------------------------------------------------ */

(() => {
  const modal = document.getElementById("info-modal");
  const trigger = document.getElementById("btn-open-info");
  const closeBtns = [
    document.getElementById("btn-close-info"),
    document.getElementById("btn-close-info-footer"),
  ];
  if (!modal || !trigger) return;

  function openModal() {
    modal.classList.add("is-visible");
    modal.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", onKeydown);
    (closeBtns[0] || modal).focus();
  }

  function closeModal() {
    modal.classList.remove("is-visible");
    modal.setAttribute("aria-hidden", "true");
    document.removeEventListener("keydown", onKeydown);
    trigger.focus();
  }

  function onKeydown(e) {
    if (e.key === "Escape") closeModal();
  }

  trigger.addEventListener("click", openModal);
  closeBtns.forEach((btn) => btn && btn.addEventListener("click", closeModal));
  modal.addEventListener("pointerdown", (e) => { if (e.target === modal) closeModal(); });
})();

/* ------------------------------------------------------------------------ */
/* Init                                                                      */
/* ------------------------------------------------------------------------ */

setTool("select");
