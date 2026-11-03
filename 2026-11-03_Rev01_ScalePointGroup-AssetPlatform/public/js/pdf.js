// Reads positioned text from a PDF in the browser with PDF.js (served locally from /vendor/pdfjs).
import { loadScript } from './ui.js';

export async function readPdfPages(file, onProgress) {
  await loadScript('/vendor/pdfjs/pdf.min.js');
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('The PDF reader could not be loaded.');
  lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js'; // same-origin worker: reading runs off the main thread
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await lib.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise;
  const pages = new Array(doc.numPages);
  let done = 0;
  const readPage = async (p) => {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const vb = vp.viewBox || [0, 0, vp.width, vp.height];
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string' || !it.str.trim()) continue;
      const t = it.transform;
      const size = Math.hypot(t[2], t[3]) || it.height || 8;
      items.push({ str: it.str, x: t[4] - vb[0], y: t[5] - vb[1], w: it.width || it.str.length * size * 0.5, size });
    }
    pages[p - 1] = { num: p, width: vb[2] - vb[0], height: vb[3] - vb[1], items };
    page.cleanup();
    done++;
    if (onProgress) onProgress(done, doc.numPages);
  };
  try {
    // Several pages in flight at once keeps the worker busy without holding every page in memory.
    const BATCH = 6;
    for (let p = 1; p <= doc.numPages; p += BATCH) {
      const batch = [];
      for (let q = p; q < p + BATCH && q <= doc.numPages; q++) batch.push(readPage(q));
      await Promise.all(batch);
    }
  } finally {
    doc.destroy();
  }
  return pages;
}
