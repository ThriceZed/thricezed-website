/* Capture session: live camera + AR target sphere + auto capture.

   Floating circles are fixed in world space on a sphere around the user
   (Street View style). The phone's orientation drives a Three.js camera over
   the live video; when the view axis lines up with an incomplete target and
   the device is steady, the shot fires automatically, bracketing exposures
   when the camera track supports exposureCompensation.

   Also contains the synthetic demo environment used when no camera or
   orientation sensor is available, so the whole pipeline can be exercised
   from a desk. */

import * as THREE from 'three';
import { OrientationService } from './orientation.js';

export const ASSUMED_DFOV = 70;   // assumed diagonal FOV of phone main camera, degrees
const ALIGN_DEG = 6;              // view must be this close to a target to lock
const HOLD_MS = 650;              // steady time before auto capture
const MAX_TURN_RATE = 15;         // deg/s; faster than this cancels the lock
const DRIFT_ABORT_DEG = 3.5;      // moving this far mid-bracket retries the shot
const GRAB_LONG_EDGE = 1920;      // stored frame long edge, px
const JPEG_Q = 0.92;
const BRACKET_EVS = [-2, 0, 2];
const SETTLE_MS = 350;            // wait after changing exposure compensation

const DEG = Math.PI / 180;

/* Ring layout covering the full sphere with generous overlap. */
const RINGS = [
  { elev: 0, count: 14 },
  { elev: 33, count: 10 }, { elev: -33, count: 10 },
  { elev: 62, count: 6 },  { elev: -62, count: 6 },
  { elev: 90, count: 1 },  { elev: -90, count: 1 },
];

export function targetDirections() {
  const dirs = [];
  for (const ring of RINGS) {
    const el = ring.elev * DEG;
    for (let i = 0; i < ring.count; i++) {
      const az = (i / ring.count) * Math.PI * 2 + (ring.elev !== 0 ? Math.PI / ring.count : 0);
      dirs.push(new THREE.Vector3(
        Math.sin(az) * Math.cos(el),
        Math.sin(el),
        -Math.cos(az) * Math.cos(el)
      ));
    }
  }
  return dirs;
}

/* Horizontal/vertical FOV (deg) of a frame with the assumed diagonal FOV. */
export function frameFov(w, h) {
  const halfDiagTan = Math.tan(ASSUMED_DFOV * DEG / 2);
  const diag = Math.hypot(w, h);
  const tanH = halfDiagTan * (w / diag);
  const tanV = halfDiagTan * (h / diag);
  return { hfov: 2 * Math.atan(tanH) / DEG, vfov: 2 * Math.atan(tanV) / DEG };
}

export class CaptureSession {
  /* opts: { video, canvas, hud, demo, onComplete, onExit }
     hud: { pct, done, total, expo, hint, compassTape, horizon, ringFill, heatmap, flash } */
  constructor(opts) {
    Object.assign(this, opts);
    this.orientation = new OrientationService();
    this.shots = [];
    this.hdrTrue = false;
    this.manualMode = false;
    this.capturing = false;
    this.running = false;
    this._raf = 0;
    this._prevQ = new THREE.Quaternion();
    this._prevT = 0;
    this._lockIdx = -1;
    this._lockStart = 0;
    this._yaw = 0;
    this._pitch = 0;
    this._tmpV = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
  }

  /* ------------------------------------------------ lifecycle */

  async start() {
    // iOS only shows the motion permission prompt while the tap gesture is
    // still fresh, so this must be the FIRST await in the chain from the
    // click. Asking after the camera prompt lets the activation expire and
    // the request auto-denies, stranding the user in drag mode.
    this._permission = 'unsupported';
    if (OrientationService.isSupported()) {
      this._permission = await this.orientation.requestPermission();
      if (this._permission === 'granted') this.orientation.start();
    }
    this._initThree();
    if (this.demo) this._initDemoEnv(); else await this._initCamera();
    if (this._permission === 'granted' && !this.orientation.hasData) {
      // sensors normally report within a frame or two; poll briefly
      const t0 = performance.now();
      while (!this.orientation.hasData && performance.now() - t0 < 1200) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    this.manualMode = !this.orientation.hasData;
    this._initManualControls();
    this._buildTargets();
    this._initHud();
    this.running = true;
    this._prevT = performance.now();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
    this.hud.hint.textContent = !this.manualMode
      ? 'Point at the glowing target'
      : (this._permission === 'denied' && !this.demo)
        ? 'Motion access denied. Reload and tap Allow, or drag to aim'
        : 'Drag to aim. Hold on a circle to capture';
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this.orientation.stop();
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    window.removeEventListener('resize', this._onResize);
    if (this.renderer) this.renderer.dispose();
    if (this._demoRenderer) this._demoRenderer.dispose();
  }

  /* ------------------------------------------------ camera */

  async _initCamera() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.track = this.stream.getVideoTracks()[0];

    // Exposure bracketing support
    this.evs = [0];
    const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
    if (caps.exposureCompensation && caps.exposureCompensation.max > caps.exposureCompensation.min) {
      const { min, max, step } = caps.exposureCompensation;
      const snap = v => {
        const clamped = Math.min(max, Math.max(min, v));
        return step ? Math.round(clamped / step) * step : clamped;
      };
      const evs = [...new Set(BRACKET_EVS.map(snap))].sort((a, b) => a - b);
      if (evs.length >= 2 && evs[evs.length - 1] - evs[0] >= 1) {
        this.evs = evs;
        this.hdrTrue = true;
      }
    }
  }

  /* ------------------------------------------------ three scene */

  _initThree() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    this._onResize = () => {
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      this.renderer.setSize(w, h, false);
      // Match the overlay FOV to the visible crop of the cover-fitted video
      const vw = this.demo ? 16 : (this.video.videoWidth || 16);
      const vh = this.demo ? 9 : (this.video.videoHeight || 9);
      const f = frameFov(vw, vh);
      const scale = Math.max(w / vw, h / vh);
      const visH = Math.min(1, h / (vh * scale));
      const tanV = Math.tan(f.vfov * DEG / 2) * visH;
      this.camera.fov = 2 * Math.atan(tanV) / DEG;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this._onResize);
    this._onResize();
  }

  _buildTargets() {
    this.targets = [];
    this.targetGroup = new THREE.Group();
    const R = 12;
    const ringGeo = new THREE.RingGeometry(0.85, 1.0, 40);
    const discGeo = new THREE.CircleGeometry(1.0, 40);
    for (const dir of targetDirections()) {
      const outline = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthTest: false })
      );
      const fill = new THREE.Mesh(
        discGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthTest: false })
      );
      const group = new THREE.Group();
      group.add(outline, fill);
      group.position.copy(dir).multiplyScalar(R);
      group.lookAt(0, 0, 0);
      this.targetGroup.add(group);
      this.targets.push({ dir: dir.clone(), done: false, outline, fill, group });
    }
    this.scene.add(this.targetGroup);
  }

  /* ------------------------------------------------ manual aiming */

  _initManualControls() {
    let dragging = false, lastX = 0, lastY = 0;
    const el = this.canvas;
    el.style.pointerEvents = 'auto';
    el.addEventListener('pointerdown', e => {
      if (!this.manualMode) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (!dragging || !this.manualMode) return;
      const k = 0.16;
      this._yaw -= (e.clientX - lastX) * k;
      this._pitch += (e.clientY - lastY) * k;
      this._pitch = Math.max(-89.9, Math.min(89.9, this._pitch));
      lastX = e.clientX; lastY = e.clientY;
    });
    el.addEventListener('pointerup', () => { dragging = false; });
    el.addEventListener('pointercancel', () => { dragging = false; });
  }

  _manualQuat(out) {
    const e = new THREE.Euler(this._pitch * DEG, this._yaw * DEG, 0, 'YXZ');
    return out.setFromEuler(e);
  }

  _currentQuat() {
    return this.manualMode
      ? this._manualQuat(new THREE.Quaternion())
      : this.orientation.quaternion.clone();
  }

  /* ------------------------------------------------ HUD */

  _initHud() {
    this.hud.pct.textContent = '0';
  }

  /* ------------------------------------------------ main loop */

  _loop(t) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.max(1, t - this._prevT) / 1000;
    this._prevT = t;

    const q = this.manualMode ? this._manualQuat(this._tmpQ) : this.orientation.quaternion;
    this.camera.quaternion.copy(q);

    // turn rate (deg/s) between frames
    const rate = 2 * Math.acos(Math.min(1, Math.abs(this._prevQ.dot(q)))) / DEG / dt;
    this._prevQ.copy(q);

    const fwd = this._tmpV.set(0, 0, -1).applyQuaternion(q);
    if (!this.capturing) this._updateTargets(fwd, rate, t);

    if (this.demoEnv) this.demoEnv.material.uniforms.uExposure.value = 1.0;
    this.renderer.render(this.scene, this.camera);
  }

  _updateTargets(fwd, rate, t) {
    let best = -1, bestAng = Infinity;
    for (let i = 0; i < this.targets.length; i++) {
      const tg = this.targets[i];
      if (tg.done) continue;
      const ang = Math.acos(Math.min(1, Math.max(-1, fwd.dot(tg.dir)))) / DEG;
      if (ang < bestAng) { bestAng = ang; best = i; }
    }
    if (best < 0) return;

    // glow the recommended target
    const pulse = 0.55 + 0.35 * Math.sin(t * 0.006);
    for (const tg of this.targets) {
      if (tg.done) continue;
      tg.outline.material.opacity = 0.45;
      tg.fill.material.opacity = 0;
      tg.group.scale.setScalar(1);
    }
    const bt = this.targets[best];
    bt.outline.material.opacity = 1;
    bt.fill.material.opacity = 0.12 * pulse;
    bt.group.scale.setScalar(1 + 0.08 * pulse);

    const circ = 289;
    const hintFree = t > (this._hintUntil || 0);
    if (bestAng < ALIGN_DEG && rate < MAX_TURN_RATE) {
      if (this._lockIdx !== best) { this._lockIdx = best; this._lockStart = t; }
      const p = Math.min(1, (t - this._lockStart) / HOLD_MS);
      this.hud.ringFill.style.strokeDashoffset = circ * (1 - p);
      if (hintFree) this.hud.hint.textContent = 'Hold steady';
      if (p >= 1) this._capture(best);
    } else {
      this._lockIdx = -1;
      this.hud.ringFill.style.strokeDashoffset = circ;
      if (!this.capturing && hintFree) {
        this.hud.hint.textContent = this.manualMode
          ? 'Drag to aim. Hold on a circle to capture'
          : (bestAng < 25 ? 'Almost there' : 'Point at the glowing target');
      }
    }
  }

  /* ------------------------------------------------ capture */

  async _capture(idx) {
    if (this.capturing) return;
    this.capturing = true;
    this._lockIdx = -1;
    const tg = this.targets[idx];
    this.hud.hint.textContent = 'Capturing. Hold still';
    try {
      const q0 = this._currentQuat();
      const evs = this.demo ? [-4, 0, 2] : this.evs;
      const bracket = [];
      for (const ev of evs) {
        if (!this.demo && this.hdrTrue) {
          try {
            await this.track.applyConstraints({ advanced: [{ exposureCompensation: ev }] });
            await new Promise(r => setTimeout(r, SETTLE_MS));
          } catch { /* keep going with whatever exposure we get */ }
        }
        // each frame gets the orientation it was actually taken at; if the
        // phone drifted off the lock pose, scrap the set and retry the target
        const q = this._currentQuat();
        const drift = 2 * Math.acos(Math.min(1, Math.abs(q0.dot(q)))) / DEG;
        if (drift > DRIFT_ABORT_DEG) {
          this.hud.hint.textContent = 'Moved during capture. Hold still and retry';
          this._hintUntil = performance.now() + 1600;
          this.hud.ringFill.style.strokeDashoffset = 289;
          return;
        }
        const shot = this.demo ? await this._grabDemo(q, ev) : await this._grabFrame();
        shot.q = [q.x, q.y, q.z, q.w];
        shot.ev = ev;
        bracket.push(shot);
      }
      this.shots.push(...bracket);
      if (!this.demo && this.hdrTrue) {
        try { await this.track.applyConstraints({ advanced: [{ exposureCompensation: 0 }] }); } catch { }
      }
      tg.done = true;
      tg.outline.material.opacity = 0.9;
      tg.fill.material.opacity = 0.55;
      tg.group.scale.setScalar(1);
      this.hud.flash.classList.add('on');
      setTimeout(() => this.hud.flash.classList.remove('on'), 60);
      if (navigator.vibrate) navigator.vibrate(25);

      const done = this.targets.filter(x => x.done).length;
      this.hud.pct.textContent = Math.round(100 * done / this.targets.length);
      this.hud.ringFill.style.strokeDashoffset = 289;

      if (done === this.targets.length) {
        this.hud.hint.textContent = 'Sphere complete';
        setTimeout(() => this.onComplete({
          shots: this.shots,
          hdrTrue: this.demo ? true : this.hdrTrue,
          simulated: this.demo ? false : !this.hdrTrue,
          demo: !!this.demo,
        }), 700);
        return;
      }
    } finally {
      this.capturing = false;
    }
  }

  async _grabFrame() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const s = Math.min(1, GRAB_LONG_EDGE / Math.max(vw, vh));
    const w = Math.round(vw * s), h = Math.round(vh * s);
    if (!this._grabCanvas) {
      this._grabCanvas = document.createElement('canvas');
      this._lumCanvas = document.createElement('canvas');
      this._lumCanvas.width = this._lumCanvas.height = 16;
    }
    this._grabCanvas.width = w; this._grabCanvas.height = h;
    const ctx = this._grabCanvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0, w, h);
    const lctx = this._lumCanvas.getContext('2d', { willReadFrequently: true });
    lctx.drawImage(this.video, 0, 0, 16, 16);
    const px = lctx.getImageData(0, 0, 16, 16).data;
    let lum = 0;
    for (let i = 0; i < px.length; i += 4) lum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    lum /= 255 * px.length / 4;
    const blob = await new Promise(r => this._grabCanvas.toBlob(r, 'image/jpeg', JPEG_Q));
    return { blob, w, h, meanLum: lum };
  }

  /* ------------------------------------------------ demo environment */

  _initDemoEnv() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uExposure: { value: 1.0 } },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        varying vec3 vDir;
        uniform float uExposure;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                     mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        float fbm(vec2 p) {
          return vnoise(p) * 0.5 + vnoise(p * 2.13) * 0.3 + vnoise(p * 4.7) * 0.2;
        }
        vec3 env(vec3 d) {
          d = normalize(d);
          vec3 sunDir = normalize(vec3(0.5, 0.55, -0.6));
          // sky gradient with non-repeating clouds
          float h = clamp(d.y, -1.0, 1.0);
          vec3 sky = mix(vec3(0.65, 0.72, 0.85), vec3(0.12, 0.2, 0.45), pow(max(h, 0.0), 0.6));
          vec2 sph = vec2(atan(d.x, -d.z), asin(h));
          if (d.y > 0.02) {
            float cl = fbm(sph * vec2(2.5, 7.0) + 13.7);
            sky = mix(sky, vec3(0.95), smoothstep(0.55, 0.8, cl) * 0.6 * smoothstep(0.02, 0.15, d.y));
          }
          // fine mottling everywhere so the scene carries matchable texture
          // at all elevations, like real environments do
          sky *= 0.88 + 0.24 * fbm(sph * 11.0) + 0.1 * vnoise(sph * 37.0);
          // sun: small very bright disk plus halo (HDR values well above 1)
          float cs = dot(d, sunDir);
          float sun = smoothstep(0.9993, 0.9998, cs) * 60.0 + pow(max(cs, 0.0), 400.0) * 4.0;
          // ground: mottled tiles, every cell uniquely shaded so patch
          // matching has non-periodic structure to lock onto
          if (d.y < -0.02) {
            vec2 g = d.xz * (1.6 / -d.y);
            vec2 cell = floor(g);
            float shade = 0.12 + 0.3 * hash(cell) + 0.12 * fbm(g * 1.7);
            vec3 tint = vec3(0.9 + 0.2 * hash(cell + 7.0), 1.0, 0.9 + 0.2 * hash(cell + 3.0));
            vec3 ground = shade * tint;
            float fade = smoothstep(0.0, 0.25, -d.y);
            return mix(sky * 0.4, ground, fade);
          }
          // colored bands at the horizon for orientation reference
          float band = smoothstep(0.16, 0.05, abs(d.y - 0.06));
          float az = atan(d.x, -d.z);
          vec3 bandCol =
            az > -0.6 && az < 0.6 ? vec3(0.8, 0.25, 0.2) :
            az > 0.97 && az < 2.17 ? vec3(0.2, 0.6, 0.3) :
            (az > 2.54 || az < -2.54) ? vec3(0.25, 0.35, 0.8) :
            az < -0.97 && az > -2.17 ? vec3(0.85, 0.7, 0.25) : vec3(0.0);
          float bandMask = band * step(0.01, dot(bandCol, vec3(1.0)));
          vec3 col = mix(sky, bandCol, bandMask * 0.85);
          return col + vec3(1.0, 0.95, 0.85) * sun;
        }
        void main() {
          vec3 lin = env(vDir) * uExposure;
          vec3 srgb = pow(clamp(lin, 0.0, 1.0), vec3(1.0 / 2.2));
          gl_FragColor = vec4(srgb, 1.0);
        }`,
    });
    this.demoEnv = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 32), mat);
    this.scene.add(this.demoEnv);
    this.video.style.display = 'none';
    // offscreen renderer for demo grabs; portrait like a real phone so ring
    // overlap matches what actual captures see
    this._demoCanvas = document.createElement('canvas');
    this._demoCanvas.width = 720; this._demoCanvas.height = 1280;
    this._demoRenderer = new THREE.WebGLRenderer({ canvas: this._demoCanvas, antialias: true });
    this._demoScene = new THREE.Scene();
    this._demoScene.add(new THREE.Mesh(this.demoEnv.geometry, mat.clone()));
    const f = frameFov(720, 1280);
    this._demoCamera = new THREE.PerspectiveCamera(f.vfov, 720 / 1280, 0.1, 100);
  }

  async _grabDemo(q, ev) {
    const env = this._demoScene.children[0];
    env.material.uniforms.uExposure.value = Math.pow(2, ev);
    this._demoCamera.quaternion.copy(q);
    this._demoRenderer.render(this._demoScene, this._demoCamera);
    const blob = await new Promise(r => this._demoCanvas.toBlob(r, 'image/jpeg', JPEG_Q));
    return { blob, w: 720, h: 1280, meanLum: 0.4 * Math.pow(2, ev) };
  }
}
