/* TZHDRI app controller: view routing, session state, and wiring between
   capture, stitching, preview, export, and stored projects. */

import { CaptureSession } from './capture.js';
import { stitchEquirect } from './stitch.js';
import { PanoViewer } from './viewer.js';
import {
  exportHDR, exportEXR, exportTIFF16, exportJPEG,
  makeThumbnail, estimateSizes, formatBytes, downloadBlob,
} from './exporters.js';
import { saveProject, listProjects, loadProject, deleteProject } from './store.js';

const $ = id => document.getElementById(id);

const views = {
  home: $('view-home'),
  projects: $('view-projects'),
  capture: $('view-capture'),
  processing: $('view-processing'),
  preview: $('view-preview'),
  export: $('view-export'),
};

const state = {
  session: null,        // { shots, hdrTrue, simulated, demo } from capture
  result: null,         // { width, height, data }
  fromProject: false,   // loaded project: no re-stitching possible
  capture: null,        // live CaptureSession
  viewer: null,
  saved: false,
};

function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  document.body.style.overflow = name === 'capture' ? 'hidden' : '';
  if (state.viewer) {
    if (name === 'preview') state.viewer.start(); else state.viewer.stop();
  }
  if (name !== 'capture' && name !== 'processing' && name !== 'preview' && name !== 'export') {
    window.scrollTo(0, 0);
  }
}

/* ------------------------------------------------ home / support report */

function renderSupportReport() {
  const secure = window.isSecureContext;
  const cam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const motion = typeof DeviceOrientationEvent !== 'undefined';
  let gl2 = false;
  try { gl2 = !!document.createElement('canvas').getContext('webgl2'); } catch { }
  const lines = [
    [cam && secure, cam && secure ? 'Camera access available' : 'No camera access. Use the synthetic demo below'],
    [motion, motion ? 'Motion sensor available' : 'No motion sensor. Aiming falls back to dragging'],
    [gl2, gl2 ? 'WebGL2 GPU processing available' : 'WebGL2 missing. Processing will not run in this browser'],
  ];
  $('support-report').innerHTML = lines.map(([ok, label]) =>
    `<div class="sup-line ${ok ? 'sup-ok' : 'sup-warn'}"><span class="dot">${ok ? '●' : '○'}</span>${label}</div>`
  ).join('');
}

/* ------------------------------------------------ tutorial */

const TUT_KEY = 'tzhdri-tutorial-seen';
let tutStep = 0;
let tutThen = null;

function openTutorial(then) {
  tutThen = then || null;
  tutStep = 0;
  $('tut-dots').innerHTML = '<span class="on"></span><span></span><span></span><span></span>';
  renderTutStep();
  $('tutorial').hidden = false;
}

function renderTutStep() {
  document.querySelectorAll('.tut-step').forEach(el => { el.hidden = +el.dataset.step !== tutStep; });
  document.querySelectorAll('#tut-dots span').forEach((d, i) => d.classList.toggle('on', i === tutStep));
  $('tut-next').textContent = tutStep === 3 ? (tutThen ? 'Start' : 'Done') : 'Next';
}

function closeTutorial(runThen) {
  $('tutorial').hidden = true;
  localStorage.setItem(TUT_KEY, '1');
  if (runThen && tutThen) tutThen();
  tutThen = null;
}

$('tut-next').addEventListener('click', () => {
  if (tutStep < 3) { tutStep++; renderTutStep(); } else closeTutorial(true);
});
$('tut-skip').addEventListener('click', () => closeTutorial(true));

/* ------------------------------------------------ capture */

async function startCapture(demo) {
  disposeSessionData();
  show('capture');
  const hud = {
    pct: $('cap-pct'), done: $('cap-done'), total: $('cap-total'),
    expo: $('cap-expo'), hint: $('cap-hint'),
    compassTape: $('compass-tape'), horizon: $('cap-horizon'),
    ringFill: $('cap-ring-fill'), heatmap: $('cap-heatmap'), flash: $('cap-flash'),
  };
  state.capture = new CaptureSession({
    video: $('cap-video'),
    canvas: $('cap-gl'),
    hud,
    demo,
    onComplete: session => {
      state.capture.stop();
      state.capture = null;
      $('cap-video').style.display = '';
      state.session = session;
      state.fromProject = false;
      processSession(defaultResolution());
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

const PROC_STEPS = [
  ['prep', 'Preparing frames'],
  ['project', 'Correcting lenses, matching exposure, projecting'],
  ['blend', 'Merging HDR and blending seams'],
  ['fill', 'Removing artifacts and filling poles'],
  ['finalize', 'Generating equirectangular maps'],
];

function renderProcSteps(activeKey) {
  const idx = PROC_STEPS.findIndex(([k]) => k === activeKey);
  $('proc-steps').innerHTML = PROC_STEPS.map(([k, label], i) => {
    const cls = i < idx ? 'done' : i === idx ? 'active' : '';
    const mark = i < idx ? '✓' : i === idx ? '›' : '·';
    return `<li class="${cls}"><span class="st">${mark}</span>${label}</li>`;
  }).join('');
}

async function processSession(width) {
  show('processing');
  renderProcSteps('prep');
  $('proc-bar-fill').style.width = '0%';
  $('proc-note').textContent = 'Everything runs on this device. Keep the page open.';
  try {
    const result = await stitchEquirect(state.session, {
      width,
      onStage: k => renderProcSteps(k),
      onProgress: p => { $('proc-bar-fill').style.width = `${Math.round(p * 100)}%`; },
    });
    state.result = result;
    state.saved = false;
    openPreview();
  } catch (err) {
    $('proc-note').textContent = 'Processing failed: ' + (err.message || err);
    const back = document.createElement('button');
    back.className = 'btn';
    back.style.marginTop = '1.5rem';
    back.textContent = 'Back';
    back.addEventListener('click', () => { back.remove(); show('home'); });
    $('proc-note').after(back);
  }
}

function defaultResolution() {
  const mem = navigator.deviceMemory || 8;
  const w = mem <= 4 ? 2048 : 4096;
  $('exp-res').value = String(w);
  return w;
}

/* ------------------------------------------------ preview */

function openPreview() {
  if (!state.viewer) state.viewer = new PanoViewer($('prev-gl'));
  state.viewer.setImage(state.result);
  const badge = $('prev-badge');
  const s = state.session || {};
  if (s.demo) {
    badge.textContent = 'SYNTHETIC DEMO';
    badge.classList.add('approx');
  } else if (s.simulated || (state.fromProject && state.projMeta && state.projMeta.simulated)) {
    badge.textContent = 'APPROXIMATED HDR';
    badge.classList.add('approx');
  } else {
    badge.textContent = 'TRUE HDR';
    badge.classList.remove('approx');
  }
  $('pv-exposure').value = 0;
  $('pv-exposure-val').textContent = '+0.0 EV';
  state.viewer.setExposureEv(0);
  state.viewer.setClipping(false);
  state.viewer.setLdrCompare(false);
  $('pv-clip').textContent = 'Clipping: Off';
  $('pv-clip').classList.remove('on');
  $('pv-compare').textContent = 'View: HDR';
  $('pv-compare').classList.remove('on');
  $('pv-save').textContent = state.saved ? 'Saved' : 'Save Project';
  show('preview');
}

$('pv-exposure').addEventListener('input', e => {
  const ev = parseFloat(e.target.value);
  $('pv-exposure-val').textContent = `${ev >= 0 ? '+' : ''}${ev.toFixed(1)} EV`;
  state.viewer.setExposureEv(ev);
});

$('pv-clip').addEventListener('click', e => {
  const on = e.target.classList.toggle('on');
  e.target.textContent = `Clipping: ${on ? 'On' : 'Off'}`;
  state.viewer.setClipping(on);
});

$('pv-compare').addEventListener('click', e => {
  const on = e.target.classList.toggle('on');
  e.target.textContent = `View: ${on ? 'JPEG' : 'HDR'}`;
  state.viewer.setLdrCompare(on);
});

$('pv-export').addEventListener('click', openExport);
$('pv-retake').addEventListener('click', () => {
  if (confirm('Discard this capture and start a new one?')) startCapture(false);
});

$('pv-save').addEventListener('click', async e => {
  if (state.saved) return;
  const name = prompt('Project name:', `HDRI ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
  if (name === null) return;
  e.target.textContent = 'Saving…';
  try {
    const thumbBlob = await makeThumbnail(state.result);
    const s = state.session || {};
    await saveProject({
      name: name || 'Untitled HDRI',
      hdrTrue: !!s.hdrTrue,
      simulated: !!s.simulated,
      result: state.result,
      thumbBlob,
    });
    state.saved = true;
    e.target.textContent = 'Saved';
  } catch (err) {
    e.target.textContent = 'Save Project';
    alert('Could not save the project: ' + (err.message || err));
  }
});

/* ------------------------------------------------ export */

function openExport() {
  const sel = $('exp-res');
  sel.disabled = state.fromProject;
  if (state.fromProject) sel.value = String(state.result.width);
  $('exp-res-note').textContent = state.fromProject
    ? 'Saved projects export at the resolution they were processed at.'
    : 'Changing resolution reprocesses the capture. 8K needs a powerful GPU and plenty of memory.';
  const s = state.session || state.projMeta || {};
  $('exp-note').textContent = s.demo
    ? 'This is a synthetic demo capture.'
    : s.simulated
      ? 'This device could not bracket exposures. The HDR output is a high quality approximation rather than true bracketed HDR.'
      : 'Bracketed exposures were captured. Output is true merged HDR radiance.';
  updateSizes();
  show('export');
}

function updateSizes() {
  const { width, height } = state.result;
  const est = estimateSizes(width, height);
  for (const fmt of ['hdr', 'exr', 'tiff', 'jpg']) {
    document.querySelector(`[data-size="${fmt}"]`).textContent = '≈ ' + formatBytes(est[fmt]);
  }
}

$('exp-res').addEventListener('change', async e => {
  const w = parseInt(e.target.value, 10);
  if (!state.session || state.fromProject || w === state.result.width) return;
  await processSession(w);
  openExport();
});

document.querySelectorAll('.exp-dl').forEach(btn => {
  btn.addEventListener('click', async () => {
    const fmt = btn.dataset.fmt;
    btn.classList.add('busy');
    btn.textContent = 'Writing…';
    await new Promise(r => setTimeout(r, 30)); // let the label paint
    try {
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
      const res = `${state.result.width / 1024}k`;
      const name = `tzhdri_${stamp}_${res}`;
      let blob;
      if (fmt === 'hdr') blob = exportHDR(state.result);
      else if (fmt === 'exr') blob = exportEXR(state.result);
      else if (fmt === 'tiff') blob = exportTIFF16(state.result);
      else blob = await exportJPEG(state.result);
      downloadBlob(blob, `${name}.${fmt === 'tiff' ? 'tif' : fmt}`);
    } catch (err) {
      alert('Export failed: ' + (err.message || err));
    } finally {
      btn.classList.remove('busy');
      btn.textContent = 'Download';
    }
  });
});

/* ------------------------------------------------ projects */

async function openProjects() {
  show('projects');
  const grid = $('projects-grid');
  grid.innerHTML = '';
  let items = [];
  try { items = await listProjects(); } catch { }
  $('projects-empty').hidden = items.length > 0;
  for (const p of items) {
    const card = document.createElement('div');
    card.className = 'proj-card';
    const img = document.createElement('img');
    img.alt = p.name;
    if (p.thumb) img.src = URL.createObjectURL(p.thumb);
    const meta = document.createElement('div');
    meta.className = 'proj-meta';
    const date = new Date(p.created).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    meta.innerHTML = `<div class="proj-name"></div>
      <div class="proj-sub">${p.width} × ${p.height} · ${p.simulated ? 'Approx HDR' : 'True HDR'} · ${date}</div>`;
    meta.querySelector('.proj-name').textContent = p.name;
    const actions = document.createElement('div');
    actions.className = 'proj-actions';
    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', async () => {
      openBtn.textContent = 'Loading…';
      try {
        const { meta: m, result } = await loadProject(p.id);
        disposeSessionData();
        state.result = result;
        state.fromProject = true;
        state.projMeta = m;
        state.session = null;
        state.saved = true;
        openPreview();
      } catch (err) {
        openBtn.textContent = 'Open';
        alert('Could not open the project: ' + (err.message || err));
      }
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
      await deleteProject(p.id);
      card.remove();
      if (!grid.children.length) $('projects-empty').hidden = false;
    });
    actions.append(openBtn, delBtn);
    card.append(img, meta, actions);
    grid.append(card);
  }
}

/* ------------------------------------------------ shared */

function disposeSessionData() {
  state.session = null;
  state.result = null;
  state.projMeta = null;
  state.fromProject = false;
  state.saved = false;
}

$('btn-start').addEventListener('click', () => {
  const go = () => startCapture(false);
  if (!localStorage.getItem(TUT_KEY)) openTutorial(go); else go();
});

$('btn-demo').addEventListener('click', e => {
  e.preventDefault();
  const go = () => startCapture(true);
  if (!localStorage.getItem(TUT_KEY)) openTutorial(go); else go();
});

$('btn-projects').addEventListener('click', openProjects);
$('btn-tutorial').addEventListener('click', () => openTutorial(null));

document.querySelectorAll('[data-nav]').forEach(el => {
  el.addEventListener('click', () => {
    const dest = el.dataset.nav;
    if (dest === 'preview') { show('preview'); return; }
    if (dest === 'home' && views.export.hidden === false) disposeSessionData();
    show(dest);
  });
});

renderSupportReport();
show('home');

// debug handle for driving the tool from the console (private tool, harmless)
window.__tzhdri = state;

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}
