/* Feature-based orientation refinement.

   The gyroscope lands every frame within a degree or two of the truth, which
   is exactly the regime where dense patch matching beats sparse keypoints.
   For each pair of overlapping views we project both frames onto a small
   shared tangent-plane patch, find the shift that maximizes normalized cross
   correlation, convert that shift into a relative rotation error, then solve
   for one small world-space rotation correction per view that best satisfies
   every pairwise measurement (a tiny orientation-only bundle adjustment).
   Corrections are applied to every bracket frame of the view. */

import * as THREE from 'three';
import { frameFov } from './capture.js';
import { K1 } from './stitch.js';

const DECODE_LONG = 512;         // matching resolution, long edge px
const PATCH = 64;                // matching patch size, px
const PATCH_FOV = 11 * Math.PI / 180; // must fit fully inside both frames
                                 // even for same-ring pairs on a portrait phone
const SEARCH = 12;               // ± shift search radius, px (~2.1 deg)
const MAX_PAIR_DEG = 45;         // views further apart than this don't overlap
const MAX_EDGES_PER_VIEW = 8;
const PATCH_OFFSETS = [-0.3, -0.15, 0, 0.15, 0.3]; // rad, spread along the
                                 // overlap band; several spots per pair also
                                 // observes roll and densifies the graph
const MIN_VALID = 0.92;          // patch must sit almost fully inside both
                                 // frames; border slivers of smooth gradient
                                 // correlate perfectly at wrong shifts
const MIN_STD = 0.008;           // reject textureless patches (plain sky)
const MIN_NCC = 0.3;             // reject unconvincing matches
const MIN_MARGIN = 0.08;         // best peak must beat rivals by this
const MAX_CORRECTION = 3 * Math.PI / 180;
const ITERS = 250;
const PASSES = 2;                // second pass re-measures the residual
const PRIOR = 0.01;              // token pull toward zero: anchors the global
                                 // gauge and pins views with no measurements,
                                 // without shrinking well-constrained ones

const DEG = Math.PI / 180;

/* Brackets are pushed per view in ascending ev order, so a non-increasing ev
   marks the start of the next view. */
function groupShots(shots) {
  const groups = [];
  let prevEv = Infinity;
  for (const s of shots) {
    if (s.ev <= prevEv) groups.push([]);
    groups[groups.length - 1].push(s);
    prevEv = s.ev;
  }
  return groups;
}

async function decodeLum(shot) {
  const url = URL.createObjectURL(shot.blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, DECODE_LONG / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * s));
    const h = Math.max(1, Math.round(img.naturalHeight * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      lum[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    }
    return { lum, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* Sampler mirroring the stitch shader's projection exactly (pinhole + k1). */
function makeSampler(view) {
  const f = frameFov(view.shot.w, view.shot.h);
  const tanH = Math.tan(f.hfov * DEG / 2);
  const tanV = Math.tan(f.vfov * DEG / 2);
  const qi = view.q.clone().conjugate();
  const { lum, w, h } = view.img;
  const d = new THREE.Vector3();
  return (dir) => {
    d.copy(dir).applyQuaternion(qi);
    if (d.z > -0.001) return NaN;
    let px = d.x / -d.z, py = d.y / -d.z;
    const rx = px / tanH, ry = py / tanV;
    const r2 = (rx * rx + ry * ry) * 0.5;
    if (r2 > 2.5) return NaN;
    const k = 1 + K1 * r2;
    px *= k; py *= k;
    const nx = px / tanH, ny = py / tanV;
    if (Math.abs(nx) >= 0.98 || Math.abs(ny) >= 0.98) return NaN;
    const u = (nx * 0.5 + 0.5) * (w - 1);
    const v = (1 - (ny * 0.5 + 0.5)) * (h - 1);
    const x0 = u | 0, y0 = v | 0;
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = u - x0, fy = v - y0;
    return lum[y0 * w + x0] * (1 - fx) * (1 - fy) + lum[y0 * w + x1] * fx * (1 - fy)
      + lum[y1 * w + x0] * (1 - fx) * fy + lum[y1 * w + x1] * fx * fy;
  };
}

/* Sample a size x size tangent-plane patch centred on dm; row direction vD
   points image-down so shifts read like pixel coordinates. */
function extractPatch(sample, dm, u, vD, size, halfTan) {
  const out = new Float32Array(size * size);
  const dir = new THREE.Vector3();
  for (let j = 0; j < size; j++) {
    const y = (2 * j / (size - 1) - 1);
    for (let i = 0; i < size; i++) {
      const x = (2 * i / (size - 1) - 1);
      dir.copy(dm)
        .addScaledVector(u, halfTan * x)
        .addScaledVector(vD, halfTan * y)
        .normalize();
      out[j * size + i] = sample(dir);
    }
  }
  return out;
}

/* Pearson correlation of A (P x P) against the window of B ((P+2S)^2) at
   offset (ox, oy) from B's top-left. NaNs (out-of-frame) are skipped. */
function ncc(A, B, P, BW, ox, oy, minValid) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let j = 0; j < P; j++) {
    const bRow = (j + oy) * BW + ox;
    const aRow = j * P;
    for (let i = 0; i < P; i++) {
      const a = A[aRow + i], b = B[bRow + i];
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
  }
  if (n < minValid * P * P) return { r: -2, n };
  const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  if (va < 1e-9 || vb < 1e-9) return { r: -2, n };
  return { r: (sab - sa * sb / n) / Math.sqrt(va * vb), n };
}

/* Coarse-to-fine shift search with sub-pixel parabola refinement and a
   peak-uniqueness test: a rival peak elsewhere in the window means the
   texture repeats (tiles, checkers, fences) and the lock cannot be trusted. */
function findShift(A, B, P, S, o) {
  const BW = P + 2 * S;
  const coarse = [];
  let best = { r: -2, ox: S, oy: S };
  for (let oy = 0; oy <= 2 * S; oy += 2) {
    for (let ox = 0; ox <= 2 * S; ox += 2) {
      const { r } = ncc(A, B, P, BW, ox, oy, o.minValid);
      coarse.push({ r, ox, oy });
      if (r > best.r) best = { r, ox, oy };
    }
  }
  if (best.r < -1) { if (o._rej) o._rej.window++; return null; }
  let rival = -2;
  for (const c of coarse) {
    if (Math.abs(c.ox - best.ox) + Math.abs(c.oy - best.oy) > 5 && c.r > rival) rival = c.r;
  }
  const margin = best.r - rival;
  if (margin < o.minMargin) { if (o._rej) o._rej.margin++; return null; }
  const scores = new Map();
  const at = (ox, oy) => {
    if (ox < 0 || oy < 0 || ox > 2 * S || oy > 2 * S) return -2;
    const k = oy * 100 + ox;
    if (!scores.has(k)) scores.set(k, ncc(A, B, P, BW, ox, oy, o.minValid).r);
    return scores.get(k);
  };
  for (let oy = best.oy - 2; oy <= best.oy + 2; oy++) {
    for (let ox = best.ox - 2; ox <= best.ox + 2; ox++) {
      const r = at(ox, oy);
      if (r > best.r) best = { r, ox, oy };
    }
  }
  if (best.r < o.minNcc) { if (o._rej) o._rej.ncc++; return null; }
  const sub = (m, p, n2) => {
    const den = m - 2 * p + n2;
    return Math.abs(den) > 1e-9 ? Math.max(-0.5, Math.min(0.5, 0.5 * (m - n2) / den)) : 0;
  };
  // a peak on the window border means the true shift is likely outside the
  // searchable range; that measurement cannot be trusted
  if (best.ox <= 0 || best.oy <= 0 || best.ox >= 2 * S || best.oy >= 2 * S) {
    if (o._rej) o._rej.border = (o._rej.border || 0) + 1;
    return null;
  }
  const dx = sub(at(best.ox - 1, best.oy), best.r, at(best.ox + 1, best.oy));
  const dy = sub(at(best.ox, best.oy - 1), best.r, at(best.ox, best.oy + 1));
  // offset S means zero shift
  return { sx: best.ox + dx - S, sy: best.oy + dy - S, r: best.r, margin };
}

function quatFromRotVec(v) {
  const angle = v.length();
  if (angle < 1e-12) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromAxisAngle(v.clone().divideScalar(angle), angle);
}

/* Mutates shot.q in place. Returns match stats for debugging.
   opts can override the matching thresholds (used for tuning). */
export async function refineOrientations(shots, onProgress = () => { }, opts = {}) {
  const o = {
    patchFov: PATCH_FOV, search: SEARCH, minValid: MIN_VALID, minStd: MIN_STD,
    minNcc: MIN_NCC, minMargin: MIN_MARGIN, offsets: PATCH_OFFSETS,
    passes: PASSES, prior: PRIOR, iters: ITERS, ...opts,
  };
  const groups = groupShots(shots);
  if (groups.length < 3) return { views: groups.length, edges: 0 };

  // representative frame per view: the ev closest to 0
  const views = groups.map(g => {
    const shot = g.reduce((a, b) => Math.abs(b.ev) < Math.abs(a.ev) ? b : a);
    const q = new THREE.Quaternion(shot.q[0], shot.q[1], shot.q[2], shot.q[3]);
    return { group: g, shot, q, fwd: new THREE.Vector3(0, 0, -1).applyQuaternion(q) };
  });

  for (let i = 0; i < views.length; i++) {
    views[i].img = await decodeLum(views[i].shot);
    onProgress(0.4 * (i + 1) / views.length);
  }

  // overlap graph: nearest views by angle
  const edges = [];
  for (let a = 0; a < views.length; a++) {
    const cand = [];
    for (let b = a + 1; b < views.length; b++) {
      const ang = views[a].fwd.angleTo(views[b].fwd) / DEG;
      if (ang < MAX_PAIR_DEG) cand.push({ b, ang });
    }
    cand.sort((x, y) => x.ang - y.ang);
    for (const { b } of cand.slice(0, MAX_EDGES_PER_VIEW)) edges.push([a, b]);
  }

  // measure and solve; the second pass re-measures the much smaller residual
  const halfTan = Math.tan(o.patchFov / 2);
  const stepRad = 2 * halfTan / (PATCH - 1); // ~radians per patch pixel
  const upRef = new THREE.Vector3(0, 1, 0);
  const xRef = new THREE.Vector3(1, 0, 0);
  let edgeCount = 0, maxDeg = 0, sumDeg = 0;

  for (let pass = 0; pass < o.passes; pass++) {
    const measured = [];
    for (let e = 0; e < edges.length; e++) {
      const [a, b] = edges[e];
      const sa = makeSampler(views[a]);
      const sb = makeSampler(views[b]);
      const dmMid = views[a].fwd.clone().add(views[b].fwd).normalize();
      // spread patches along the overlap band, perpendicular to the
      // baseline arc between the two view directions
      const axis = new THREE.Vector3().crossVectors(views[a].fwd, views[b].fwd).normalize();
      const tangent = new THREE.Vector3().crossVectors(axis, dmMid).normalize();
      for (const off of o.offsets) {
        const dm = dmMid.clone().applyQuaternion(
          new THREE.Quaternion().setFromAxisAngle(tangent, off)
        );
        const ref = Math.abs(dm.dot(upRef)) > 0.9 ? xRef : upRef;
        const u = new THREE.Vector3().crossVectors(dm, ref).normalize();
        const vD = new THREE.Vector3().crossVectors(dm, u);
        const scale = (PATCH + 2 * o.search) / PATCH;
        const A = extractPatch(sa, dm, u, vD, PATCH, halfTan);
        let n = 0, s1 = 0, s2 = 0;
        for (const v of A) if (!Number.isNaN(v)) { n++; s1 += v; s2 += v * v; }
        if (n < o.minValid * PATCH * PATCH) { if (o._rej) o._rej.valid++; continue; }
        if (Math.sqrt(s2 / n - (s1 / n) ** 2) < o.minStd) { if (o._rej) o._rej.std++; continue; }
        const B = extractPatch(sb, dm, u, vD, PATCH + 2 * o.search, halfTan * scale);
        const hit = findShift(A, B, PATCH, o.search, o);
        if (!hit) continue;
        // shift (sx, sy) of B's content -> world rotation error of B vs A
        const r = new THREE.Vector3()
          .addScaledVector(u, stepRad * hit.sy)
          .addScaledVector(vD, -stepRad * hit.sx);
        // n: a tangent-plane shift says nothing about rotation around the
        // patch axis itself, so the constraint must not clamp that component
        measured.push({ a, b, r, n: dm.clone(), w: Math.min(1, Math.max(0.05, hit.margin)) });
        if (o.collect) {
          o.collect.push({
            pass, a, b, off, sx: +hit.sx.toFixed(2), sy: +hit.sy.toFixed(2),
            ncc: +hit.r.toFixed(2), margin: +hit.margin.toFixed(2),
            shiftDeg: +(Math.hypot(hit.sx, hit.sy) * stepRad / DEG).toFixed(2),
            elevA: +(Math.asin(views[a].fwd.y) / DEG).toFixed(0),
            elevB: +(Math.asin(views[b].fwd.y) / DEG).toFixed(0),
            offElev: +(Math.asin(dm.y) / DEG).toFixed(0),
          });
        }
      }
      onProgress(0.4 + 0.6 * (pass + (e + 1) / edges.length) / o.passes);
    }
    edgeCount = measured.length;

    // global relaxation: per-view corrections c with c_b - c_a = r, made
    // robust by reweighting rounds that suppress outlier measurements
    // (wrong locks from repeated texture or out-of-window true shifts)
    const c = views.map(() => new THREE.Vector3());
    const acc = new THREE.Vector3();
    const res = new THREE.Vector3();
    for (const m of measured) m.wr = m.w;
    for (let round = 0; round < 3; round++) {
      const tv = new THREE.Vector3();
      for (let it = 0; it < o.iters; it++) {
        for (let i = 0; i < views.length; i++) {
          acc.set(0, 0, 0);
          let wSum = o.prior; // prior pulls toward zero, anchoring the gauge
          for (const m of measured) {
            if (m.b === i) tv.copy(c[m.a]).add(m.r);
            else if (m.a === i) tv.copy(c[m.b]).sub(m.r);
            else continue;
            // keep this node's own component along the patch axis: the
            // measurement is blind in that direction
            tv.addScaledVector(m.n, c[i].dot(m.n) - tv.dot(m.n));
            acc.addScaledVector(tv, m.wr);
            wSum += m.wr;
          }
          c[i].copy(acc.divideScalar(wSum));
        }
      }
      if (round === 2) break;
      const resid = measured.map(m => {
        res.copy(c[m.b]).sub(c[m.a]).sub(m.r);
        res.addScaledVector(m.n, -res.dot(m.n)); // blind axis carries no error
        return res.length();
      });
      const sorted = [...resid].sort((x, y) => x - y);
      const scale = (sorted[Math.floor(sorted.length / 2)] || 0) * 1.4826 + 1e-4;
      measured.forEach((m, k) => {
        const t = resid[k] / (2.5 * scale);
        m.wr = m.w / (1 + t * t); // Cauchy weight
      });
    }

    // apply corrections to the view and every bracket frame in its group
    for (let i = 0; i < views.length; i++) {
      if (c[i].length() > MAX_CORRECTION) c[i].setLength(MAX_CORRECTION);
      maxDeg = Math.max(maxDeg, c[i].length() / DEG);
      sumDeg += c[i].length() / DEG;
      const dq = quatFromRotVec(c[i]);
      views[i].q.premultiply(dq);
      views[i].fwd.set(0, 0, -1).applyQuaternion(views[i].q);
      for (const s of views[i].group) {
        const q = new THREE.Quaternion(s.q[0], s.q[1], s.q[2], s.q[3]).premultiply(dq);
        s.q = [q.x, q.y, q.z, q.w];
      }
    }
  }

  for (const v of views) v.img = null; // release decoded luminance
  onProgress(1);
  return { views: views.length, edges: edgeCount, maxDeg, meanDeg: sumDeg / views.length / o.passes };
}
