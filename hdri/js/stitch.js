/* Equirectangular stitcher.

   Every captured frame is reprojected into a float equirectangular buffer on
   the GPU. For each output pixel we compute the world direction, rotate it
   into the shot's camera space using the recorded orientation quaternion, and
   sample the photo through an ideal pinhole model with a mild barrel
   distortion term. Contributions accumulate as (premultiplied color, weight)
   with additive blending; weights combine seam feathering with an exposure
   hat function, which is also what merges bracketed exposures into HDR
   radiance (each bracket is scaled by 2^-ev into a common linear scale and
   trusted only where its pixels are neither blown out nor crushed).

   A normalize pass divides out the weight, then a few dilation passes fill
   any remaining pinholes near the poles.

   Honest limits: alignment comes from the orientation sensor, not feature
   matching, and per-shot auto exposure is compensated statistically. Overlap
   and feathering hide most of it, but this is a phone capture tool, not a
   tripod rig. */

import * as THREE from 'three';
import { frameFov } from './capture.js';

const K1 = -0.07;          // gentle barrel undistortion typical of phone mains
const FEATHER = 0.22;      // frame-edge feather width in texture space
const DILATE_PASSES = 12;

const QUAT_GLSL = `
  vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
  vec3 srgb2lin(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
`;

const FSQ_VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const PROJECT_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform vec4 uQInv;         // conjugate of the shot's camera quaternion
  uniform vec2 uTanHV;        // tan of half hfov / vfov
  uniform float uScale;       // 2^-ev * exposure-match gain
  uniform float uK1;
  uniform float uWLoFloor;    // keep-floor for crushed pixels (brightest bracket)
  uniform float uWHiFloor;    // keep-floor for blown pixels (darkest bracket)
  uniform float uSingle;      // 1 = unbracketed shot, weight everything
  uniform float uExpand;      // 1 = expand highlights (simulated HDR)
  ${QUAT_GLSL}
  void main() {
    float lon = (vUv.x - 0.5) * 6.28318530718;
    float lat = (vUv.y - 0.5) * 3.14159265359;
    vec3 dir = vec3(sin(lon) * cos(lat), sin(lat), -cos(lon) * cos(lat));
    vec3 d = qrot(uQInv, dir);
    if (d.z > -0.001) { discard; }
    vec2 pn = d.xy / -d.z;
    float r2 = dot(pn / uTanHV, pn / uTanHV) * 0.5;
    // distortion is only valid near the frustum; far off-axis the polynomial
    // folds back and would smear a mirrored ghost across the panorama
    if (r2 > 2.5) { discard; }
    pn *= 1.0 + uK1 * r2;
    vec2 ndc = pn / uTanHV;
    if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0) { discard; }
    vec2 tuv = ndc * 0.5 + 0.5;
    vec3 srgb = texture2D(uTex, tuv).rgb;
    vec3 lin = srgb2lin(srgb);
    float m = max(srgb.r, max(srgb.g, srgb.b));
    if (uExpand > 0.5) {
      float l = dot(lin, vec3(0.2126, 0.7152, 0.0722));
      lin /= max(0.06, 1.0 - 0.92 * smoothstep(0.72, 1.0, l));
    }
    float wHi = max(1.0 - smoothstep(0.88, 0.99, m), uWHiFloor);
    float wLo = max(smoothstep(0.015, 0.09, m), uWLoFloor);
    float wVal = mix(wLo * wHi, 1.0, uSingle);
    vec2 eb = min(tuv, 1.0 - tuv);
    float wEdge = smoothstep(0.0, ${FEATHER.toFixed(3)}, min(eb.x, eb.y));
    float w = wVal * wEdge + 1e-5;
    gl_FragColor = vec4(lin * uScale * w, w);
  }
`;

const NORMALIZE_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uAccum;
  void main() {
    vec4 a = texture2D(uAccum, vUv);
    if (a.a < 1e-4) { gl_FragColor = vec4(0.0); return; }
    gl_FragColor = vec4(a.rgb / a.a, 1.0);
  }
`;

const DILATE_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uSrc;
  uniform vec2 uTexel;
  void main() {
    vec4 c = texture2D(uSrc, vUv);
    if (c.a > 0.5) { gl_FragColor = c; return; }
    vec3 sum = vec3(0.0);
    float n = 0.0;
    for (int dy = -1; dy <= 1; dy++)
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        vec2 uv = vUv + vec2(float(dx), float(dy)) * uTexel;
        uv.x = fract(uv.x);   // wrap the seam
        vec4 s = texture2D(uSrc, uv);
        if (s.a > 0.5) { sum += s.rgb; n += 1.0; }
      }
    gl_FragColor = n > 0.0 ? vec4(sum / n, 1.0) : vec4(0.0);
  }
`;

async function blobToCanvas(blob, canvas) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fullscreenQuad(material) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return scene;
}

function makeRT(w, h) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
}

/* Exposure matching: phone auto exposure shifts between directions, and we
   cannot read the actual EV used, so we compensate statistically from each
   bracket-set's base (ev = 0) mean luminance. Partial strength, because scene
   brightness legitimately varies by direction too. */
function exposureGains(shots) {
  const bases = shots.filter(s => s.ev === 0).map(s => s.meanLum).sort((a, b) => a - b);
  if (!bases.length) return () => 1;
  const median = bases[Math.floor(bases.length / 2)] || 0.5;
  return (baseLum) => {
    const g = Math.pow(median / Math.max(0.02, baseLum), 0.6);
    return Math.min(2.5, Math.max(0.4, g));
  };
}

/* session: { shots, hdrTrue, simulated, demo }
   opts: { width, onStage(label), onProgress(0..1) }
   Returns { width, height, data: Float32Array RGBA }. */
export async function stitchEquirect(session, { width, onStage, onProgress }) {
  const height = width / 2;
  const { shots } = session;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: false });
  renderer.autoClear = false;

  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    throw new Error('WebGL2 is required for HDR processing on this device.');
  }
  const maxTex = renderer.capabilities.maxTextureSize;
  if (width > maxTex) {
    renderer.dispose();
    throw new Error(`This GPU supports up to ${maxTex} px wide output. Choose a lower resolution.`);
  }

  const camera = new THREE.Camera();
  let accum, rtA, rtB;
  try {
    accum = makeRT(width, height);
    rtA = makeRT(width, height);
    rtB = makeRT(width, height);
  } catch (e) {
    renderer.dispose();
    throw new Error('Not enough graphics memory for this resolution. Try a lower one.');
  }

  // ---- pass 1: accumulate all shots
  onStage('project');
  const srcCanvas = document.createElement('canvas');
  const tex = new THREE.CanvasTexture(srcCanvas);
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const projMat = new THREE.ShaderMaterial({
    vertexShader: FSQ_VERT,
    fragmentShader: PROJECT_FRAG,
    uniforms: {
      uTex: { value: tex },
      uQInv: { value: new THREE.Vector4() },
      uTanHV: { value: new THREE.Vector2() },
      uScale: { value: 1 },
      uK1: { value: K1 },
      uWLoFloor: { value: 0 },
      uWHiFloor: { value: 0 },
      uSingle: { value: 0 },
      uExpand: { value: 0 },
    },
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const projScene = fullscreenQuad(projMat);

  renderer.setRenderTarget(accum);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);

  const gainFor = exposureGains(shots);
  const evsSorted = [...new Set(shots.map(s => s.ev))].sort((a, b) => a - b);
  const evLo = evsSorted[0], evHi = evsSorted[evsSorted.length - 1];
  const single = evsSorted.length === 1;

  // base-lum lookup per bracket set: shots arrive grouped per target
  let baseLum = 0.5;
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    if (s.ev === 0) baseLum = s.meanLum;
    await blobToCanvas(s.blob, srcCanvas);
    tex.needsUpdate = true;
    const f = frameFov(s.w, s.h);
    projMat.uniforms.uTanHV.value.set(Math.tan(f.hfov * Math.PI / 360), Math.tan(f.vfov * Math.PI / 360));
    projMat.uniforms.uQInv.value.set(-s.q[0], -s.q[1], -s.q[2], s.q[3]);
    projMat.uniforms.uScale.value = Math.pow(2, -s.ev) * gainFor(baseLum);
    projMat.uniforms.uSingle.value = single ? 1 : 0;
    projMat.uniforms.uWHiFloor.value = (!single && s.ev === evLo) ? 0.08 : 0;
    projMat.uniforms.uWLoFloor.value = (!single && s.ev === evHi) ? 0.08 : 0;
    projMat.uniforms.uExpand.value = session.simulated ? 1 : 0;
    renderer.setRenderTarget(accum);
    renderer.render(projScene, camera);
    onProgress(0.05 + 0.7 * (i + 1) / shots.length);
    if (i % 8 === 7) await new Promise(r => setTimeout(r, 0)); // let the UI breathe
  }

  // ---- pass 2: normalize
  onStage('blend');
  const normMat = new THREE.ShaderMaterial({
    vertexShader: FSQ_VERT,
    fragmentShader: NORMALIZE_FRAG,
    uniforms: { uAccum: { value: accum.texture } },
    depthTest: false, depthWrite: false,
  });
  const normScene = fullscreenQuad(normMat);
  renderer.setRenderTarget(rtA);
  renderer.clear(true, false, false);
  renderer.render(normScene, camera);
  onProgress(0.8);

  // ---- pass 3: dilate to fill pinholes
  onStage('fill');
  const dilMat = new THREE.ShaderMaterial({
    vertexShader: FSQ_VERT,
    fragmentShader: DILATE_FRAG,
    uniforms: {
      uSrc: { value: rtA.texture },
      uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
    },
    depthTest: false, depthWrite: false,
  });
  const dilScene = fullscreenQuad(dilMat);
  let src = rtA, dst = rtB;
  for (let p = 0; p < DILATE_PASSES; p++) {
    dilMat.uniforms.uSrc.value = src.texture;
    renderer.setRenderTarget(dst);
    renderer.clear(true, false, false);
    renderer.render(dilScene, camera);
    [src, dst] = [dst, src];
    onProgress(0.8 + 0.12 * (p + 1) / DILATE_PASSES);
  }

  // ---- readback
  onStage('finalize');
  let data;
  try {
    data = new Float32Array(width * height * 4);
  } catch (e) {
    throw new Error('Not enough memory to hold this resolution. Try a lower one.');
  }
  renderer.readRenderTargetPixels(src, 0, 0, width, height, data);
  onProgress(1);

  // GL reads bottom-up; flip rows so row 0 is the top of the panorama
  const rowFloats = width * 4;
  const tmp = new Float32Array(rowFloats);
  for (let y = 0; y < height / 2; y++) {
    const a = y * rowFloats, b = (height - 1 - y) * rowFloats;
    tmp.set(data.subarray(a, a + rowFloats));
    data.copyWithin(a, b, b + rowFloats);
    data.set(tmp, b);
  }

  tex.dispose(); accum.dispose(); rtA.dispose(); rtB.dispose();
  projMat.dispose(); normMat.dispose(); dilMat.dispose();
  renderer.dispose();

  return { width, height, data };
}
