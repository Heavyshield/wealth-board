// OPTIONAL Google Drive login (computer). The phone flow (open / share the file) never needs it.
// Why the full "drive" scope: files saved from a phone's share sheet are created by the Drive app,
// so the minimal drive.file scope would not see them. This code only ever touches files named
// wealth-board.json (and lists folders so the user can pick where it lives). Token in memory only (~1 h), never stored.

export const SCOPE = 'https://www.googleapis.com/auth/drive';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FIELDS = 'id,name,modifiedTime,version,md5Checksum,parents,lastModifyingUser(displayName)';
const FOLDER = 'application/vnd.google-apps.folder';
/** Escape a value for a Drive query string literal. */
const lit = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

let gis = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gis ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => { gis = null; reject(new Error('Google indisponible (hors ligne ?)')); };
    document.head.append(s);
  });
  return gis;
}

/** Ask for a token (opens Google's window; must follow a click). Returns { token, expires }. */
export async function signIn(clientId) {
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPE,
      callback: (r) => (r.error ? reject(new Error(`connexion refusée : ${r.error}`)) : resolve({ token: r.access_token, expires: Date.now() + (Number(r.expires_in) - 60) * 1000 })),
      error_callback: (e) => reject(new Error(e?.type === 'popup_closed' ? 'fenêtre Google fermée' : 'connexion Google impossible')),
    });
    client.requestAccessToken();
  });
}

function caller(token, f) {
  async function call(url, init = {}) {
    const res = await f(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new Error('connexion Google expirée : reconnectez-vous');
    if (!res.ok) { let m = `HTTP ${res.status}`; try { m = (await res.json()).error?.message ?? m; } catch { /* */ } throw new Error(`Drive : ${m}`); }
    return res;
  }
  return { call, json: async (url, init) => (await call(url, init)).json() };
}

/**
 * Drive calls for one file name, optionally limited to one folder (`folderId`: list only there, create there).
 * `fetch` injectable for tests.
 */
export function driveFiles(token, name, f = (...a) => fetch(...a), folderId = null) {
  const { call, json } = caller(token, f);
  return {
    /** All non-trashed copies (in the folder when one is set), newest first. */
    async list() {
      const q = encodeURIComponent(`name='${lit(name)}' and trashed=false${folderId ? ` and '${lit(folderId)}' in parents` : ''}`);
      return (await json(`${API}/files?q=${q}&orderBy=modifiedTime%20desc&fields=files(${FIELDS})&spaces=drive`)).files ?? [];
    },
    meta: (id) => json(`${API}/files/${id}?fields=${FIELDS}`),
    read: async (id) => (await call(`${API}/files/${id}?alt=media`)).text(),
    /** Overwrite in place (Drive keeps the previous version in its history). */
    update: (id, text) => json(`${UPLOAD}/files/${id}?uploadType=media&fields=${FIELDS}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: text }),
    async create(text) {
      const b = `wb${Math.random().toString(36).slice(2)}`;
      const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: 'application/json', ...(folderId ? { parents: [folderId] } : {}) })}\r\n--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${b}--`;
      return json(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
    },
    /** Move to Drive's trash (recoverable for 30 days). */
    trash: (id) => json(`${API}/files/${id}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }),
  };
}

/** Folder browsing for the "where does wealth-board.json live" picker. 'root' = My Drive. */
export function driveFolders(token, f = (...a) => fetch(...a)) {
  const { json } = caller(token, f);
  return {
    /** Sub-folders of `parentId`, by name. */
    async children(parentId = 'root') {
      const q = encodeURIComponent(`mimeType='${FOLDER}' and '${lit(parentId)}' in parents and trashed=false`);
      return (await json(`${API}/files?q=${q}&orderBy=name&fields=files(id,name)&pageSize=200&spaces=drive`)).files ?? [];
    },
    /** Path from My Drive down to folder `id`: [{ id, name }], My Drive first. At most 15 levels. */
    async path(id) {
      const out = [];
      let cur = id;
      for (let i = 0; i < 15 && cur; i++) {
        const m = await json(`${API}/files/${encodeURIComponent(cur)}?fields=id,name,parents`);
        out.unshift({ id: m.id, name: m.parents?.length ? m.name : 'Mon Drive' });
        cur = m.parents?.[0];
      }
      return out;
    },
    create: (name, parentId = 'root') => json(`${API}/files?fields=id,name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
    }),
  };
}
