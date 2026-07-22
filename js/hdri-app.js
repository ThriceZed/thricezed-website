/* ============================================================================
   ThriceZed 360° HDRI Capture: guided 360° environment capture.

   Pipeline:
     1. Live rear-camera preview + device-orientation tracking.
     2. Target dots arranged on a sphere; when the phone's view aligns with a
        dot we auto-capture that tile (bracketing exposures where the browser
        allows it) and store the frame + its orientation quaternion + exposure.
     3. Reproject every tile into an equirectangular buffer in linear light,
        merging exposures into HDR radiance.
     4. Export a Radiance .hdr file + a tone-mapped .jpg preview.

   Orientation math: we build the camera rotation as a quaternion the same way
   THREE.js DeviceOrientationControls does (Euler order YXZ + a -90° X twist so
   the camera looks out the back of the phone, + a screen-orientation term).
   This keeps the common "phone held upright at the horizon" pose at the stable
   centre of the range instead of Euler gimbal-lock, which otherwise makes the
   guide dots jump around and scatters the stitched tiles. World frame is Y-up.

   Honest limits:
     - Stitching uses each frame's device orientation (not feature matching),
       so seam quality depends on sensor accuracy. Overlap + feathering hide
       most of it. This is a convenience tool, not a tripod bracketing rig.
     - True exposure bracketing needs MediaStreamTrack exposure control, which
       Android Chrome usually offers and iOS Safari does not. Without it we
       capture one exposure per tile (still a valid, narrower-range .hdr).
   ========================================================================== */
(function () {
  'use strict';

  // ---- Assumed camera DIAGONAL field of view, degrees. Typical phone main
  //      camera. Deriving focal length from the frame diagonal makes it
  //      orientation-independent; overlap forgives the remaining error.
  var DFOV_DEG = 72;

  // ---- Capture geometry
  var ALIGN_DEG = 10;      // how close the view must be to a dot to lock
  var HOLD_MS = 550;       // must stay locked this long before auto-capture
  var TILE_W = 320;        // downscaled stored tile width (px)

  // ---- Output
  var OUT_W = 2048, OUT_H = 1024;

  // ---------------------------------------------------------------- elements
  var $ = function (id) { return document.getElementById(id); };
  var video = $('cam');
  var overlay = $('overlay');
  var octx = overlay.getContext('2d');

  var panels = {
    intro: $('panel-intro'), proc: $('panel-proc'),
    result: $('panel-result'), error: $('panel-error')
  };
  var hud = $('hud'), capbar = $('capbar');
  var pDone = $('p-done'), pTotal = $('p-total'), hudHint = $('hud-hint');
  var statusPill = $('status-pill');

  // ---------------------------------------------------------------- state
  var stream = null, track = null;
  var orient = { alpha: 0, beta: 0, gamma: 0, ok: false };
  var screenAngle = 0;
  var targets = [];        // {dir:[x,y,z], done:bool}
  var captures = [];       // {q:[x,y,z,w], ev:number, w,h, data:Uint8ClampedArray}
  var lockedIdx = -1, lockStart = 0, capturing = false, running = false;
  var exposure = { supported: false, evs: [0], caps: null };
  var grabCanvas = document.createElement('canvas');
  var grabCtx = grabCanvas.getContext('2d', { willReadFrequently: true });

  var DEG = Math.PI / 180;

  // ============================================================ math helpers

  function normalize(v) {
    var l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  // ---- Quaternions stored as [x, y, z, w] ----
  function quatMul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  }
  // rotate vec3 v by quaternion q
  function quatApply(q, v) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var tx = 2 * (y * v[2] - z * v[1]);
    var ty = 2 * (z * v[0] - x * v[2]);
    var tz = 2 * (x * v[1] - y * v[0]);
    return [
      v[0] + w * tx + (y * tz - z * ty),
      v[1] + w * ty + (z * tx - x * tz),
      v[2] + w * tz + (x * ty - y * tx)
    ];
  }
  function quatConj(q) { return [-q[0], -q[1], -q[2], q[3]]; }

  var HALF = Math.sqrt(0.5);
  var Q_BACK = [-HALF, 0, 0, HALF]; // -90° about X: camera looks out the phone's back

  // Device orientation (deg) + screen angle (deg) -> camera quaternion.
  // Mirrors THREE.js DeviceOrientationControls: Euler(beta, alpha, -gamma, YXZ),
  // then the back-facing twist, then the screen-orientation term. World is Y-up.
  function orientationQuat(alphaDeg, betaDeg, gammaDeg, screenDeg) {
    var x = betaDeg * DEG, y = alphaDeg * DEG, z = -gammaDeg * DEG; // Euler YXZ inputs
    var c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    var s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    var qe = [
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 - s1 * s2 * c3,
      c1 * c2 * c3 + s1 * s2 * s3
    ];
    var s = -screenDeg * DEG / 2;
    var q0 = [0, 0, Math.sin(s), Math.cos(s)]; // -screen about Z
    return quatMul(quatMul(qe, Q_BACK), q0);
  }

  // The world direction the rear camera points (camera local -Z into world).
  function cameraForward(q) { return quatApply(q, [0, 0, -1]); }

  // Focal length in pixels for a frame of size w×h, from the diagonal FOV.
  function focalFromFrame(w, h) {
    return (Math.hypot(w, h) / 2) / Math.tan((DFOV_DEG * DEG) / 2);
  }

  // ============================================================ target sphere

  function buildTargets() {
    targets = [];
    // Rings of dots by elevation; density scaled roughly by cos(elevation).
    var rings = [
      { el: 0,   n: 8 },
      { el: 30,  n: 8 },
      { el: -30, n: 8 },
      { el: 60,  n: 6 },
      { el: -60, n: 6 }
    ];
    rings.forEach(function (r) {
      for (var i = 0; i < r.n; i++) {
        var az = (360 / r.n) * i;
        targets.push({ dir: dirFromAzEl(az, r.el), done: false });
      }
    });
    targets.push({ dir: [0, 1, 0], done: false });   // zenith (up)
    targets.push({ dir: [0, -1, 0], done: false });  // nadir (down)
    pTotal.textContent = targets.length;
  }

  // azimuth around +Y-up, elevation from horizon. Azimuth 0 == -Z (neutral
  // forward). Matches the equirect mapping below and the quaternion frame.
  function dirFromAzEl(azDeg, elDeg) {
    var az = azDeg * DEG, el = elDeg * DEG;
    var c = Math.cos(el);
    return [c * Math.sin(az), Math.sin(el), -c * Math.cos(az)];
  }

  // world dir -> equirect pixel (u,v). +Y up, longitude 0 at -Z.
  function dirToUV(d) {
    var lon = Math.atan2(d[0], -d[2]);       // -pi..pi
    var lat = Math.asin(Math.max(-1, Math.min(1, d[1]))); // -pi/2..pi/2
    return [(lon / (2 * Math.PI) + 0.5) * OUT_W, (0.5 - lat / Math.PI) * OUT_H];
  }

  function angleBetween(a, b) {
    var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return Math.acos(Math.max(-1, Math.min(1, d))) / DEG;
  }

  // ============================================================ overlay draw

  function resizeOverlay() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    overlay.width = Math.round(window.innerWidth * dpr);
    overlay.height = Math.round(window.innerHeight * dpr);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Project a world direction to a screen pixel using the current camera
  // quaternion. Returns {x,y} in CSS pixels, or null if behind the camera.
  function projectToScreen(q, dir) {
    var p = quatApply(quatConj(q), dir);  // world -> camera local
    if (p[2] >= -0.001) return null;      // behind or on the camera plane
    var W = window.innerWidth, H = window.innerHeight;
    var f = focalFromFrame(W, H);
    var x = W / 2 + f * (p[0] / -p[2]);
    var y = H / 2 - f * (p[1] / -p[2]);
    return { x: x, y: y };
  }

  function drawOverlay() {
    octx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (!orient.ok || !running) { return; }
    var m = orientationQuat(orient.alpha, orient.beta, orient.gamma, screenAngle);
    var cx = window.innerWidth / 2, cy = window.innerHeight / 2;

    // center reticle
    octx.strokeStyle = 'rgba(255,255,255,0.9)';
    octx.lineWidth = 2;
    octx.beginPath(); octx.arc(cx, cy, 26, 0, Math.PI * 2); octx.stroke();
    octx.beginPath(); octx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    octx.fillStyle = 'rgba(255,255,255,0.9)'; octx.fill();

    // dots
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (t.done) continue;
      var s = projectToScreen(m, t.dir);
      if (!s) continue;
      var onScreen = s.x > -40 && s.x < window.innerWidth + 40 && s.y > -40 && s.y < window.innerHeight + 40;
      if (!onScreen) continue;
      var d = Math.hypot(s.x - cx, s.y - cy);
      var near = d < 90;
      octx.beginPath();
      octx.arc(s.x, s.y, near ? 16 : 11, 0, Math.PI * 2);
      octx.fillStyle = near ? 'rgba(124,255,155,0.28)' : 'rgba(255,255,255,0.14)';
      octx.fill();
      octx.lineWidth = 2;
      octx.strokeStyle = near ? 'rgba(124,255,155,0.95)' : 'rgba(255,255,255,0.6)';
      octx.stroke();
    }
  }

  // ============================================================ capture loop

  function tick() {
    if (!running) return;
    drawOverlay();
    if (!capturing && orient.ok) {
      var m = orientationQuat(orient.alpha, orient.beta, orient.gamma, screenAngle);
      var fwd = cameraForward(m);
      // find nearest un-done target to the current view center
      var best = -1, bestAng = 1e9;
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].done) continue;
        var ang = angleBetween(fwd, targets[i].dir);
        if (ang < bestAng) { bestAng = ang; best = i; }
      }
      if (best >= 0 && bestAng <= ALIGN_DEG) {
        if (lockedIdx !== best) { lockedIdx = best; lockStart = performance.now(); }
        setStatus(true, 'Hold steady…');
        if (performance.now() - lockStart >= HOLD_MS) {
          captureTile(best, m);
        }
      } else {
        lockedIdx = -1;
        setStatus(false, 'Move to a target dot');
      }
    }
    requestAnimationFrame(tick);
  }

  function setStatus(locked, text) {
    statusPill.textContent = text;
    statusPill.classList.toggle('locked', locked);
  }

  function grabFrame() {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    var w = TILE_W, h = Math.round(TILE_W * vh / vw);
    grabCanvas.width = w; grabCanvas.height = h;
    grabCtx.drawImage(video, 0, 0, w, h);
    return { w: w, h: h, data: grabCtx.getImageData(0, 0, w, h).data };
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function setExposureComp(ev) {
    if (!exposure.supported || !track) return;
    try {
      await track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureCompensation: ev }] });
      await sleep(220); // let the sensor settle
    } catch (e) { /* ignore, treat as single exposure */ }
  }

  async function captureTile(idx, q) {
    capturing = true;
    hudHint.textContent = 'Capturing…';
    var evList = exposure.supported ? exposure.evs : [0];
    for (var k = 0; k < evList.length; k++) {
      if (exposure.supported) await setExposureComp(evList[k]);
      var f = grabFrame();
      if (f) {
        captures.push({
          q: q, ev: Math.pow(2, evList[k]), w: f.w, h: f.h, data: f.data
        });
      }
    }
    if (exposure.supported) { try { await setExposureComp(0); } catch (e) {} }

    targets[idx].done = true;
    pDone.textContent = targets.filter(function (t) { return t.done; }).length;
    hudHint.textContent = 'Follow the dots';
    lockedIdx = -1;
    capturing = false;

    if (targets.every(function (t) { return t.done; })) finish();
  }

  // ============================================================ processing

  function show(name) {
    Object.keys(panels).forEach(function (k) { panels[k].classList.toggle('show', k === name); });
    var capUI = (name === null);
    hud.classList.toggle('show', capUI);
    capbar.classList.toggle('show', capUI);
  }

  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  // Debevec-style hat weight favouring well-exposed midtones (input 0..255)
  function hatWeight(v) {
    var x = v / 255;
    return (x <= 0.5 ? x : 1 - x) * 2 + 0.02;
  }

  async function processCaptures() {
    var N = OUT_W * OUT_H;
    var accR = new Float32Array(N), accG = new Float32Array(N), accB = new Float32Array(N);
    var accW = new Float32Array(N);

    var procBar = $('proc-bar'), procMsg = $('proc-msg');

    for (var ci = 0; ci < captures.length; ci++) {
      var cap = captures[ci];
      var q = cap.q, data = cap.data, w = cap.w, h = cap.h;
      var cxp = w / 2, cyp = h / 2;
      var fx = focalFromFrame(w, h), fy = fx; // square pixels, diagonal-FOV focal
      for (var sy = 0; sy < h; sy++) {
        for (var sx = 0; sx < w; sx++) {
          var o = (sy * w + sx) * 4;
          var r8 = data[o], g8 = data[o + 1], b8 = data[o + 2];
          // camera-local ray for this pixel (camera looks along -Z)
          var xp = (sx + 0.5 - cxp) / fx;
          var yp = (cyp - (sy + 0.5)) / fy;
          var dv = normalize([xp, yp, -1]);
          var world = quatApply(q, dv);
          var uv = dirToUV(world);
          var lum = 0.2126 * r8 + 0.7152 * g8 + 0.0722 * b8;
          // radial feather: fade tile edges to hide seams
          var rr = Math.hypot((sx - cxp) / cxp, (sy - cyp) / cyp);
          var feather = Math.max(0, 1 - rr * rr);
          var wgt = hatWeight(lum) * feather;
          if (wgt <= 0) continue;
          var lr = srgbToLinear(r8) / cap.ev;
          var lg = srgbToLinear(g8) / cap.ev;
          var lb = srgbToLinear(b8) / cap.ev;
          splat(accR, accG, accB, accW, uv[0], uv[1], lr, lg, lb, wgt);
        }
      }
      procBar.style.width = Math.round((ci + 1) / captures.length * 70) + '%';
      procMsg.textContent = 'Reprojecting tiles… ' + (ci + 1) + '/' + captures.length;
      await sleep(0); // yield so the UI can paint
    }

    // resolve accumulation into radiance
    procMsg.textContent = 'Merging exposures…';
    var rad = new Float32Array(N * 3);
    for (var i = 0; i < N; i++) {
      var wv = accW[i];
      if (wv > 0) {
        rad[i * 3] = accR[i] / wv; rad[i * 3 + 1] = accG[i] / wv; rad[i * 3 + 2] = accB[i] / wv;
      }
    }
    $('proc-bar').style.width = '85%';
    await sleep(0);
    fillHoles(rad, accW, OUT_W, OUT_H);
    $('proc-bar').style.width = '100%';
    return rad;
  }

  // bilinear splat into equirect accumulation, wrapping horizontally
  function splat(aR, aG, aB, aW, u, v, r, g, b, wgt) {
    var x0 = Math.floor(u - 0.5), y0 = Math.floor(v - 0.5);
    var fx = (u - 0.5) - x0, fy = (v - 0.5) - y0;
    for (var j = 0; j < 2; j++) {
      for (var i = 0; i < 2; i++) {
        var wx = i ? fx : 1 - fx, wy = j ? fy : 1 - fy;
        var ww = wx * wy * wgt;
        if (ww <= 0) continue;
        var yy = y0 + j; if (yy < 0 || yy >= OUT_H) continue;
        var xx = ((x0 + i) % OUT_W + OUT_W) % OUT_W;
        var idx = yy * OUT_W + xx;
        aR[idx] += r * ww; aG[idx] += g * ww; aB[idx] += b * ww; aW[idx] += ww;
      }
    }
  }

  // Fill any pixels that received no samples by spreading from neighbours.
  function fillHoles(rad, accW, W, H) {
    var filled = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) filled[i] = accW[i] > 0 ? 1 : 0;
    for (var pass = 0; pass < 6; pass++) {
      var changed = 0;
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var idx = y * W + x;
          if (filled[idx]) continue;
          var sr = 0, sg = 0, sb = 0, n = 0;
          for (var dy = -1; dy <= 1; dy++) {
            var yy = y + dy; if (yy < 0 || yy >= H) continue;
            for (var dx = -1; dx <= 1; dx++) {
              var xx = ((x + dx) % W + W) % W;
              var nIdx = yy * W + xx;
              if (filled[nIdx]) { sr += rad[nIdx * 3]; sg += rad[nIdx * 3 + 1]; sb += rad[nIdx * 3 + 2]; n++; }
            }
          }
          if (n > 0) { rad[idx * 3] = sr / n; rad[idx * 3 + 1] = sg / n; rad[idx * 3 + 2] = sb / n; filled[idx] = 2; changed++; }
        }
      }
      // promote newly filled so they seed the next pass
      for (var k = 0; k < W * H; k++) if (filled[k] === 2) filled[k] = 1;
      if (!changed) break;
    }
  }

  // ============================================================ HDR encoding

  // Radiance .hdr (RGBE), flat/old-format scanlines, widely readable (Blender,
  // Maya, Nuke, PBRT). Input: linear radiance Float32Array length W*H*3.
  function encodeHDR(rad, W, H) {
    var header = '#?RADIANCE\nSOFTWARE=ThriceZed HDRI Capture\nFORMAT=32-bit_rle_rgbe\n\n-Y ' + H + ' +X ' + W + '\n';
    var head = new TextEncoder().encode(header);
    var body = new Uint8Array(W * H * 4);
    for (var i = 0; i < W * H; i++) {
      floatToRgbe(rad[i * 3], rad[i * 3 + 1], rad[i * 3 + 2], body, i * 4);
    }
    var out = new Uint8Array(head.length + body.length);
    out.set(head, 0); out.set(body, head.length);
    return new Blob([out], { type: 'image/vnd.radiance' });
  }

  function floatToRgbe(r, g, b, out, o) {
    r = r > 0 ? r : 0; g = g > 0 ? g : 0; b = b > 0 ? b : 0;
    var v = Math.max(r, g, b);
    if (v < 1e-32) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; return; }
    var e = Math.ceil(Math.log(v) / Math.LN2);      // 2^e >= v
    var scale = 256 / Math.pow(2, e);
    // round (not floor) to halve mantissa quantization error on dim channels
    out[o]     = Math.min(255, Math.round(r * scale));
    out[o + 1] = Math.min(255, Math.round(g * scale));
    out[o + 2] = Math.min(255, Math.round(b * scale));
    out[o + 3] = e + 128;
  }

  // Tone-mapped preview -> canvas -> jpeg blob/dataURL
  function makePreview(rad, W, H) {
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(W, H);
    var d = img.data;
    // auto-exposure: aim median-ish luminance, then Reinhard + gamma
    var key = 0.18, sum = 0, cnt = 0;
    for (var i = 0; i < W * H; i++) {
      var l = 0.2126 * rad[i * 3] + 0.7152 * rad[i * 3 + 1] + 0.0722 * rad[i * 3 + 2];
      if (l > 0) { sum += Math.log(l + 1e-4); cnt++; }
    }
    var avg = cnt ? Math.exp(sum / cnt) : 0.18;
    var expScale = key / (avg + 1e-4);
    for (var p = 0; p < W * H; p++) {
      var o = p * 4;
      d[o]     = tm(rad[p * 3] * expScale);
      d[o + 1] = tm(rad[p * 3 + 1] * expScale);
      d[o + 2] = tm(rad[p * 3 + 2] * expScale);
      d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }
  function tm(x) {
    x = x / (1 + x);                       // Reinhard
    x = Math.pow(Math.max(0, x), 1 / 2.2); // gamma
    return Math.max(0, Math.min(255, Math.round(x * 255)));
  }

  // ============================================================ flow control

  var lastHdrBlob = null, lastPreviewCanvas = null;

  async function finish() {
    running = false;
    show('proc');
    await sleep(30);
    var rad;
    try {
      rad = await processCaptures();
    } catch (e) {
      return fail('Processing failed: ' + (e && e.message ? e.message : e));
    }
    lastHdrBlob = encodeHDR(rad, OUT_W, OUT_H);
    lastPreviewCanvas = makePreview(rad, OUT_W, OUT_H);
    $('result-preview').src = lastPreviewCanvas.toDataURL('image/jpeg', 0.9);
    var mb = (lastHdrBlob.size / (1024 * 1024)).toFixed(1);
    var meta = OUT_W + '×' + OUT_H + ' equirectangular · ' + captures.length + ' frames · ' + mb + ' MB';
    if (!exposure.supported) {
      meta += '  ·  ⚠ single-exposure (limited dynamic range on this device)';
      $('result-meta').classList.add('warn');
    }
    $('result-meta').textContent = meta;
    stopCamera();
    show('result');
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function stamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function fail(msg) {
    running = false;
    stopCamera();
    $('error-msg').textContent = msg;
    show('error');
  }

  function stopCamera() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; track = null; }
  }

  // ---------------------------------------------------------------- start

  async function requestOrientation() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        var res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') return false;
      } catch (e) { return false; }
    }
    window.addEventListener('deviceorientation', onOrient, true);
    return true;
  }

  function onOrient(e) {
    if (e.alpha === null && e.beta === null && e.gamma === null) return;
    orient.alpha = e.alpha || 0;
    orient.beta = e.beta || 0;
    orient.gamma = e.gamma || 0;
    orient.ok = true;
  }

  function readScreenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') screenAngle = screen.orientation.angle;
    else if (typeof window.orientation === 'number') screenAngle = window.orientation;
    else screenAngle = 0;
  }

  async function probeExposure() {
    exposure.supported = false; exposure.evs = [0];
    if (!track || !track.getCapabilities) return;
    var caps;
    try { caps = track.getCapabilities(); } catch (e) { return; }
    exposure.caps = caps;
    if (caps && caps.exposureMode && Array.prototype.indexOf.call(caps.exposureMode, 'manual') >= 0 &&
        caps.exposureCompensation && typeof caps.exposureCompensation.max === 'number') {
      var lo = Math.max(caps.exposureCompensation.min, -2);
      var hi = Math.min(caps.exposureCompensation.max, 2);
      if (hi - lo >= 1) { exposure.supported = true; exposure.evs = [lo, 0, hi]; }
    }
  }

  async function start() {
    show('proc'); $('proc-msg').textContent = 'Starting camera…'; $('proc-bar').style.width = '10%';

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return fail('This browser has no camera access. Open in Safari or Chrome on a phone.');
    }
    if (!window.isSecureContext) {
      return fail('Camera needs a secure (HTTPS) connection.');
    }

    var okOrient = await requestOrientation();
    if (!okOrient) {
      return fail('Motion-sensor access was denied. The tool needs it to know where the phone is pointing. Reload and allow motion access.');
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
    } catch (e) {
      return fail('Could not open the camera: ' + (e && e.name ? e.name : e) + '. Check camera permissions.');
    }
    video.srcObject = stream;
    track = stream.getVideoTracks()[0];
    try { await video.play(); } catch (e) {}

    await probeExposure();

    // wait briefly for orientation events to start flowing
    var waited = 0;
    while (!orient.ok && waited < 1500) { await sleep(100); waited += 100; }

    buildTargets();
    captures = [];
    resizeOverlay();
    running = true;
    show(null);
    hudHint.textContent = exposure.supported ? 'Bracketing on · follow the dots' : 'Follow the dots';
    requestAnimationFrame(tick);

    if (!orient.ok) {
      // sensors never fired; likely a desktop or blocked, so let them try but warn
      setStatus(false, 'No motion sensor detected. Use a phone');
    }
  }

  // ---------------------------------------------------------------- events

  $('btn-start').addEventListener('click', start);
  $('btn-retry').addEventListener('click', function () { show('intro'); });
  $('btn-restart').addEventListener('click', function () { location.reload(); });
  $('btn-finish').addEventListener('click', function () {
    if (captures.length === 0) { setStatus(false, 'Capture at least one dot first'); return; }
    finish();
  });
  $('btn-manual').addEventListener('click', function () {
    if (!running || capturing || !orient.ok) return;
    var m = orientationQuat(orient.alpha, orient.beta, orient.gamma, screenAngle);
    var fwd = cameraForward(m);
    var best = -1, bestAng = 1e9;
    for (var i = 0; i < targets.length; i++) {
      if (targets[i].done) continue;
      var ang = angleBetween(fwd, targets[i].dir);
      if (ang < bestAng) { bestAng = ang; best = i; }
    }
    if (best >= 0) captureTile(best, m);
  });
  $('btn-recenter').addEventListener('click', function () {
    // convenience: mark the current view as captured toward nearest dot anyway
    setStatus(false, 'Move to a target dot');
  });
  $('btn-dl-hdr').addEventListener('click', function () {
    if (lastHdrBlob) download(lastHdrBlob, 'thricezed-hdri-' + stamp() + '.hdr');
  });
  $('btn-dl-jpg').addEventListener('click', function () {
    if (lastPreviewCanvas) lastPreviewCanvas.toBlob(function (b) {
      if (b) download(b, 'thricezed-hdri-' + stamp() + '.jpg');
    }, 'image/jpeg', 0.92);
  });

  window.addEventListener('resize', function () { resizeOverlay(); readScreenAngle(); });
  window.addEventListener('orientationchange', readScreenAngle);
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', readScreenAngle);
  }

  // ---------------------------------------------------------------- init
  readScreenAngle();
})();
