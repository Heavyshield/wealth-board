// Local folder fallback (File System Access API: Chrome / Edge desktop; not on phones or Firefox/Safari).
// Point it at a folder synced by Google Drive for desktop and the same three JSON files are shared
// without OAuth. The folder handle is remembered in IndexedDB; the browser asks again for permission
// when needed. Conflicts: a file modified on disk since we last read/wrote it -> ask, never overwrite.

const DB = 'wealth-board', STORE = 'handles', KEY = 'folder';
export const folderSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ id: 'wealth-board', mode: 'readwrite' });
  await idb('readwrite', (s) => s.put(handle, KEY));
  return handle;
}

/** Remembered folder with read/write permission (asks the browser if needed; must follow a click). */
export async function getFolder() {
  const handle = await idb('readonly', (s) => s.get(KEY));
  if (!handle) return null;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted' || (await handle.requestPermission(opts)) === 'granted') return handle;
  return null;
}

export const folderName = async () => (await idb('readonly', (s) => s.get(KEY)))?.name ?? null;

/** Read `<file>.json` for each file present. Returns { file: { data | error, lastModified } }. */
export async function readFolder(handle, files) {
  const out = {};
  for (const f of files) {
    try {
      const fh = await handle.getFileHandle(`${f}.json`);
      const file = await fh.getFile();
      try { out[f] = { data: JSON.parse(await file.text()), lastModified: file.lastModified }; } catch (e) { out[f] = { error: `JSON illisible : ${e.message}`, lastModified: file.lastModified }; }
    } catch { /* absent */ }
  }
  return out;
}

export async function lastModified(handle, f) {
  try { return (await (await handle.getFileHandle(`${f}.json`)).getFile()).lastModified; } catch { return null; }
}

/** Write one file; returns its new lastModified. */
export async function writeFile(handle, f, text) {
  const fh = await handle.getFileHandle(`${f}.json`, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
  return (await fh.getFile()).lastModified;
}
