/* TZHDRI app controller. Minimal flow: home -> capture -> processing ->
   result with one primary EXR download. */

import { CaptureSession } from './capture.js';
import { stitchEquirect } from './stitch.js';
import { PanoViewer } from './viewer.js';
import { exportHDR, exportEXR, exportTIFF16, exportJPEG, estimateSizes, formatBytes, downloadBlob } from './exporters.js';

const $ = id => document.getElementById(id);

const views = {
  home: $('view-home'),
  capture: $('view-capture'),
  processing: $('view-processing'),
  result: $('view-result'),
};

const state = { session: null, result: null, capture: null, viewer: null };

function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  document.body.style.overflow = name === 'capture' ? 'hidden' : '';
  if (state.viewer) {
    if (name === 'result') state.viewer.start(); else state.viewer.stop();
  }
  if (name === 'home') window.scrollTo(0, 0);
}

/* ------------------------------------------------ capture */

async function startCapture(demo) {
  state.session = null;
  state.result = null;
  show('capture');
  state.capture = new CaptureSession({
    video: $('cap-video'),
    canvas: $('cap-gl'),
    hud: { pct: $('cap-pct'), hint: $('cap-hint'), ringFill: $('cap-ring-fill'), flash: $('cap-flash') },
    demo,
    onComplete: session => {
      state.capture.stop();
      state.capture = null;
      $('cap-video').style.display = '';
      state.session = session;
      processSession(parseInt($('exp-res').value, 10));
    },
  });
  try {
    await state.capture.start();
  } catch (err) {
    exitCapture();
    alert(err && err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow camera access and try again.'
      : 'Could not start the capture session: ' + (err.message || err));
  }
}

function exitCapture() {
  if (state.capture) { state.capture.stop(); state.capture = null; }
  $('cap-video').style.display = '';
  show('home');
}

$('cap-exit').addEventListener('click', exitCapture);

/* ------------------------------------------------ processing */

const STAGE_NOTES = {
  align: 'Matching features between frames…',
  project: 'Merging exposures and stitching…',
  blend: 'Blending seams…',
  fill: 'Filling poles…',
  finalize: 'Finalizing…',
};

async function processSession(width) {
  show('processing');
  $('proc-bar-fill').style.width = '0%';
  $('proc-note').textContent = 'Stays on this device. Keep the page open.';
  try {
    state.result = await stitchEquirect(state.session, {
      width,
      onStage: k => { $('proc-note').textContent = STAGE_NOTES[k] || 'Processing…'; },
      onProgress: p => { $('proc-bar-fill').style.width = `${Math.round(p * 100)}%`; },
    });
    openResult();
  } catch (err) {
    $('proc-note').textContent = 'Processing failed: ' + (err.message || err) + ' Reload to try again.';
  }
}

function defaultResolution() {
  const mem = navigator.deviceMemory || 8;
  const w = mem <= 4 ? 2048 : 4096;
  $('exp-res').value = String(w);
  return w;
}

/* ------------------------------------------------ result */

function openResult() {
  if (!state.viewer) state.viewer = new PanoViewer($('prev-gl'));
  state.viewer.setImage(state.result);
  $('pv-exposure').value = 0;
  $('pv-exposure-val').textContent = '+0.0 EV';
  state.viewer.setExposureEv(0);
  const { width, height } = state.result;
  $('exr-size').textContent = '≈ ' + formatBytes(estimateSizes(width, height).exr);
  const s = state.session;
  $('result-note').textContent = `${width} × ${height} · ` + (s.demo
    ? 'synthetic demo capture'
    : s.simulated
      ? 'single-exposure device, HDR is approximated'
      : 'true bracketed HDR');
  show('result');
}

$('pv-exposure').addEventListener('input', e => {
  const ev = parseFloat(e.target.value);
  $('pv-exposure-val').textContent = `${ev >= 0 ? '+' : ''}${ev.toFixed(1)} EV`;
  state.viewer.setExposureEv(ev);
});

function stampName() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `tzhdri_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}_${state.result.width / 1024}k`;
}

async function download(fmt, el) {
  el.classList.add('busy');
  await new Promise(r => setTimeout(r, 30));
  try {
    let blob;
    if (fmt === 'exr') blob = exportEXR(state.result);
    else if (fmt === 'hdr') blob = exportHDR(state.result);
    else if (fmt === 'tiff') blob = exportTIFF16(state.result);
    else blob = await exportJPEG(state.result);
    downloadBlob(blob, `${stampName()}.${fmt === 'tiff' ? 'tif' : fmt}`);
  } catch (err) {
    alert('Export failed: ' + (err.message || err));
  } finally {
    el.classList.remove('busy');
  }
}

$('dl-exr').addEventListener('click', e => download('exr', e.currentTarget));
document.querySelectorAll('.dl-alt').forEach(a => {
  a.addEventListener('click', e => { e.preventDefault(); download(a.dataset.fmt, a); });
});

$('exp-res').addEventListener('change', async e => {
  const w = parseInt(e.target.value, 10);
  if (!state.session || w === state.result.width) return;
  await processSession(w);
});

$('btn-again').addEventListener('click', e => {
  e.preventDefault();
  startCapture(false);
});

/* ------------------------------------------------ home */

$('btn-start').addEventListener('click', () => startCapture(false));
$('btn-demo').addEventListener('click', e => { e.preventDefault(); startCapture(true); });

defaultResolution();
show('home');

// debug handle for driving the tool from the console (private tool, harmless)
window.__tzhdri = state;

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}
