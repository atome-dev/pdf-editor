// app.js expects window.pdfjsLib to already exist, so it's only injected once
// js/boot-pdfjs.js (a module, deferred by default) has actually run.
function bootPdfEditorApp() {
  const s = document.createElement("script");
  s.src = "js/app.js";
  document.body.appendChild(s);
}
if (window.pdfjsLib) bootPdfEditorApp();
else window.addEventListener("pdfjslib-ready", bootPdfEditorApp, { once: true });
