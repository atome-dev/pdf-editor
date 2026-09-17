// Bridges the ES-module pdf.js build onto `window.pdfjsLib` so the rest of the app
// (a classic, non-module script) can use it as a plain global. Kept in its own file
// (rather than inline in index.html) so the CSP script-src can stay strict — no
// 'unsafe-inline' needed anywhere.
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs";
window.pdfjsLib = pdfjsLib;
window.dispatchEvent(new Event("pdfjslib-ready"));
