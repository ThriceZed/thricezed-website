/* Device orientation service.
   Produces a camera quaternion (Y-up world, camera looks down -Z) from
   deviceorientation events, matching the classic THREE DeviceOrientationControls
   construction: Euler(beta, alpha, -gamma, 'YXZ'), then a -90deg X twist so the
   camera looks out the back of the phone, then a screen-orientation term.
   Building the rotation as a quaternion keeps the upright-at-horizon pose away
   from Euler gimbal lock. */

import * as THREE from 'three';

const DEG = Math.PI / 180;
const Q_BACK = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class OrientationService {
  constructor() {
    this.quaternion = new THREE.Quaternion();
    this.hasData = false;
    this.enabled = false;
    this._euler = new THREE.Euler();
    this._qScreen = new THREE.Quaternion();
    this._onEvent = this._onEvent.bind(this);
  }

  static isSupported() {
    return typeof DeviceOrientationEvent !== 'undefined';
  }

  /* Must be called from a user gesture on iOS. Resolves 'granted' | 'denied' | 'unsupported'. */
  async requestPermission() {
    if (!OrientationService.isSupported()) return 'unsupported';
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        return await DeviceOrientationEvent.requestPermission();
      } catch {
        return 'denied';
      }
    }
    return 'granted';
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    // deviceorientationabsolute (Android Chrome) gives a compass-referenced alpha
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', this._onEvent, true);
    } else {
      window.addEventListener('deviceorientation', this._onEvent, true);
    }
  }

  stop() {
    this.enabled = false;
    this.hasData = false;
    window.removeEventListener('deviceorientationabsolute', this._onEvent, true);
    window.removeEventListener('deviceorientation', this._onEvent, true);
  }

  _screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }
    return typeof window.orientation === 'number' ? window.orientation : 0;
  }

  _onEvent(e) {
    if (e.alpha === null || e.alpha === undefined) return;
    const alpha = e.alpha * DEG;
    const beta = (e.beta || 0) * DEG;
    const gamma = (e.gamma || 0) * DEG;
    this._euler.set(beta, alpha, -gamma, 'YXZ');
    this.quaternion.setFromEuler(this._euler);
    this.quaternion.multiply(Q_BACK);
    this._qScreen.setFromAxisAngle(Z_AXIS, -this._screenAngle() * DEG);
    this.quaternion.multiply(this._qScreen);
    this.hasData = true;
  }
}
