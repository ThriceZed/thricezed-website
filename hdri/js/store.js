/* Project persistence in IndexedDB.

   The float panorama is stored RGBE-encoded (4 bytes per pixel instead of 16)
   in a separate object store from the browsable metadata, so listing projects
   never loads panorama payloads. */

import { floatToRgbe, rgbeToFloat } from './exporters.js';

const DB_NAME = 'tzhdri';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('payload')) db.createObjectStore('payload');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function saveProject({ name, hdrTrue, simulated, result, thumbBlob }) {
  const { width, height, data } = result;
  const rgbe = new Uint8Array(width * height * 4);
  for (let p = 0, n = width * height; p < n; p++) {
    floatToRgbe(data[p * 4], data[p * 4 + 1], data[p * 4 + 2], rgbe, p * 4);
  }
  const id = `p${Date.now()}`;
  const db = await openDb();
  await tx(db, ['meta', 'payload'], 'readwrite', t => {
    t.objectStore('meta').put({ id, name, created: Date.now(), width, height, hdrTrue, simulated, thumb: thumbBlob });
    t.objectStore('payload').put(new Blob([rgbe]), id);
    return {};
  });
  db.close();
  return id;
}

export async function listProjects() {
  const db = await openDb();
  const items = await new Promise((resolve, reject) => {
    const req = db.transaction('meta').objectStore('meta').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return items.sort((a, b) => b.created - a.created);
}

export async function loadProject(id) {
  const db = await openDb();
  const [meta, payload] = await Promise.all([
    new Promise((res, rej) => {
      const r = db.transaction('meta').objectStore('meta').get(id);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }),
    new Promise((res, rej) => {
      const r = db.transaction('payload').objectStore('payload').get(id);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }),
  ]);
  db.close();
  if (!meta || !payload) throw new Error('Project not found');
  const rgbe = new Uint8Array(await payload.arrayBuffer());
  const data = new Float32Array(meta.width * meta.height * 4);
  for (let p = 0, n = meta.width * meta.height; p < n; p++) {
    rgbeToFloat(rgbe, p * 4, data, p * 4);
    data[p * 4 + 3] = 1;
  }
  return { meta, result: { width: meta.width, height: meta.height, data } };
}

export async function deleteProject(id) {
  const db = await openDb();
  await tx(db, ['meta', 'payload'], 'readwrite', t => {
    t.objectStore('meta').delete(id);
    t.objectStore('payload').delete(id);
    return {};
  });
  db.close();
}
