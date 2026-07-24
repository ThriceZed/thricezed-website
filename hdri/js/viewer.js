/* Interactive equirect panorama viewer.

   Renders the stitched float buffer on the inside of a sphere with the same
   direction convention as the stitcher (lon 0 = -Z), so what you framed is
   where you look. Supports exposure preview, clipping visualization, and an
   LDR compare mode that shows the image as the tone-mapped JPEG would look. */

import * as THREE from 'three';

const FRAG = `
  precision highp float;
  varying vec3 vDir;
  uniform sampler2D uTex;
  uniform float uExposure;   // 2^ev
  vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
  vec3 lin2srgb(vec3 c) {
    return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  void main() {
    vec3 d = normalize(vDir);
    float lon = atan(d.x, -d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    vec2 uv = vec2(lon / 6.28318530718 + 0.5, 0.5 - lat / 3.14159265359);
    vec3 lin = texture2D(uTex, uv).rgb;
    gl_FragColor = vec4(lin2srgb(aces(lin * uExposure)), 1.0);
  }
`;

const VERT = `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export class PanoViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      uniforms: {
        uTex: { value: null },
        uExposure: { value: 1 },
      },
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 48), this.material));
    this.yaw = 0; this.pitch = 0;
    this.running = false;
    this._initControls();
    this._onResize = this._resize.bind(this);
    window.addEventListener('resize', this._onResize);
  }

  /* result: { width, height, data: Float32Array RGBA }. Downsampled to a
     GPU-friendly size for display; exports always use the full buffer. */
  setImage(result) {
    let { width, height, data } = result;
    const MAXW = 4096;
    while (width > MAXW) {
      const w2 = width / 2, h2 = height / 2;
      const out = new Float32Array(w2 * h2 * 4);
      for (let y = 0; y < h2; y++) {
        for (let x = 0; x < w2; x++) {
          const o = (y * w2 + x) * 4;
          const a = (y * 2 * width + x * 2) * 4;
          const b = a + 4, c = a + width * 4, d = c + 4;
          for (let k = 0; k < 3; k++) {
            out[o + k] = (data[a + k] + data[b + k] + data[c + k] + data[d + k]) * 0.25;
          }
          out[o + 3] = 1;
        }
      }
      width = w2; height = h2; data = out;
    }
    if (this.texture) this.texture.dispose();
    this.texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    this.material.uniforms.uTex.value = this.texture;
  }

  setExposureEv(ev) { this.material.uniforms.uExposure.value = Math.pow(2, ev); }

  start() {
    if (this.running) return;
    this.running = true;
    this._resize();
    const loop = () => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      const e = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(e);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    if (this.texture) this.texture.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }

  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _initControls() {
    const el = this.canvas;
    const pointers = new Map();
    let pinchDist = 0;
    el.addEventListener('pointerdown', e => {
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      el.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      }
    });
    el.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 1) {
        const k = 0.0022 * this.camera.fov / 75;
        this.yaw += (e.clientX - prev[0]) * k;
        this.pitch += (e.clientY - prev[1]) * k;
        this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinchDist > 0) this._zoom((pinchDist - d) * 0.15);
        pinchDist = d;
      }
    });
    const up = e => { pointers.delete(e.pointerId); pinchDist = 0; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      this._zoom(e.deltaY * 0.05);
    }, { passive: false });
  }

  _zoom(delta) {
    this.camera.fov = Math.max(25, Math.min(110, this.camera.fov + delta));
    this.camera.updateProjectionMatrix();
  }
}
