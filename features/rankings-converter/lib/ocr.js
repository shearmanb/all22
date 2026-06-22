// lib/ocr.js — screenshot -> text via Tesseract.js (offline OCR, no API key).
//
// Assets are bundled in the repo so OCR works with NO runtime network access:
//   - the English model lives in ./tessdata/eng.traineddata.gz
//   - the WASM core comes from the tesseract.js-core package in node_modules
// This avoids Tesseract's default behaviour of fetching them from a CDN (which
// is blocked in some networks and, on failure, used to crash the process).
//
// The worker is heavy to spin up, so we lazily create ONE shared worker and
// reuse it. If init fails we clear the cached promise so the next call retries
// rather than being stuck with a broken worker.
const path = require('path');
const os = require('os');

// The English model is bundled in this feature's own tessdata/ folder.
const LANG_PATH = path.join(__dirname, '..', 'tessdata');
// The WASM core lives in the repo-root node_modules; resolve it by package so
// it works regardless of where this module sits in the tree.
const CORE_PATH = path.dirname(require.resolve('tesseract.js-core/package.json'));

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = require('tesseract.js');
      const worker = await createWorker('eng', 1, {
        langPath: LANG_PATH,        // read eng.traineddata.gz from disk
        corePath: CORE_PATH,        // local WASM core
        cachePath: os.tmpdir(),     // decompressed model cache (not in the repo)
        gzip: true,
      });
      // Rankings are a single column of one-line rows. PSM 6 ("assume a uniform
      // block of text") reads such lists more reliably than the default auto
      // mode, which can mis-segment screenshots that have side chrome. Keeping
      // interword spaces intact preserves the "Name  POS  TEAM" gaps the parser
      // relies on.
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          preserve_interword_spaces: '1',
        });
      } catch (e) {
        // Non-fatal: fall back to defaults if a param isn't supported.
        console.error(`ocr: setParameters failed: ${e.message}`);
      }
      return worker;
    })().catch((err) => {
      workerPromise = null;       // allow a retry on the next request
      throw err;
    });
  }
  return workerPromise;
}

// Accepts a data URL ("data:image/png;base64,..."), a raw base64 string, or a
// Buffer. Returns the recognized text.
function toImageInput(image) {
  if (Buffer.isBuffer(image)) return image;
  if (typeof image === 'string') {
    const m = image.match(/^data:[^;]+;base64,(.*)$/);
    if (m) return Buffer.from(m[1], 'base64');
    if (/^[A-Za-z0-9+/=\s]+$/.test(image) && image.length > 100) {
      return Buffer.from(image.replace(/\s+/g, ''), 'base64');
    }
  }
  return image;
}

async function imageToText(image) {
  const worker = await getWorker();
  const input = toImageInput(image);
  const { data } = await worker.recognize(input);
  return data.text || '';
}

module.exports = { imageToText };
