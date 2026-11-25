// Google Drive access from the browser: Google Identity Services (OAuth token, scope drive.file)
// + Drive REST v3 with fetch. drive.file = the app only sees files IT created (or the user opened
// with it), nothing else in the user's Drive. Token kept in memory only (about 1 hour).
//
// The client is created with injectable fetch/token functions so tests run against a fake Drive.

export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const META = 'id,name,version,modifiedTime,lastModifyingUser(displayName)';
export const APP_TAG = 'wealthboard'; // appProperties key marking our folder and files

export class DriveError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- sign-in (GIS)
let gisPromise = null;
/** Load the Google Identity Services script once (only when the user asks for Drive). */
export function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisPromise = null; reject(new DriveError('impossible de charger Google Identity Services (hors ligne ?)')); };
    document.head.append(s);
  });
  return gisPromise;
}

/**
 * Token provider. `get({ interactive })` resolves an access token.
 * interactive=false tries silently (works once consent was given, may still need a click on some browsers).
 */
export function createTokenProvider(clientId) {
  let token = null, expires = 0, client = null;
  async function request(prompt) {
    await loadGis();
    return new Promise((resolve, reject) => {
      client ??= window.google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPE, callback: () => {} });
      client.callback = (resp) => {
        if (resp.error) return reject(new DriveError(`connexion Google refusée : ${resp.error_description ?? resp.error}`));
        token = resp.access_token;
        expires = Date.now() + (Number(resp.expires_in) - 60) * 1000;
        resolve(token);
      };
      client.error_callback = (err) => reject(new DriveError(err?.type === 'popup_closed' ? 'fenêtre Google fermée' : `connexion Google impossible (${err?.type ?? 'erreur'})`));
      client.requestAccessToken({ prompt });
    });
  }
  return {
    async get({ interactive = false } = {}) {
      if (token && Date.now() < expires) return token;
      return request(interactive ? 'select_account' : '');
    },
    invalidate() { token = null; expires = 0; },
    revoke() { if (token) window.google?.accounts?.oauth2?.revoke(token, () => {}); token = null; expires = 0; },
    get hasToken() { return Boolean(token && Date.now() < expires); },
  };
}

// ---------------------------------------------------------------- REST client
/**
 * Drive client. deps: { fetch, getToken: () => Promise<string>, onUnauthorized?: () => void }
 * All methods throw DriveError with a French message.
 */
export function createDriveClient({ fetch: f = (...a) => fetch(...a), getToken, onUnauthorized }) {
  async function call(url, init = {}, retry = true) {
    const token = await getToken();
    const res = await f(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
    if (res.status === 401 && retry) { onUnauthorized?.(); return call(url, init, false); }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const b = await res.json(); msg = b?.error?.message ?? msg; } catch { /* not json */ }
      throw new DriveError(`Drive : ${msg}`, res.status);
    }
    return res;
  }
  const json = async (url, init) => (await call(url, init)).json();
  const q = (s) => encodeURIComponent(s);

  return {
    /** Find our folder (by app tag) or create it. Returns its id. */
    async ensureFolder(name) {
      const found = await json(`${API}/files?q=${q(`mimeType='${FOLDER_MIME}' and trashed=false and appProperties has { key='${APP_TAG}' and value='folder' }`)}&fields=files(id,name)&spaces=drive`);
      if (found.files?.length) return found.files[0].id;
      const created = await json(`${API}/files?fields=id`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, appProperties: { [APP_TAG]: 'folder' } }),
      });
      return created.id;
    },
    /** Files in our folder: { name: meta }. */
    async listFiles(folderId) {
      const r = await json(`${API}/files?q=${q(`'${folderId}' in parents and trashed=false`)}&fields=files(${META})&spaces=drive`);
      return Object.fromEntries((r.files ?? []).map((m) => [m.name, m]));
    },
    getMeta: (id) => json(`${API}/files/${id}?fields=${META}`),
    async readText(id) { return (await call(`${API}/files/${id}?alt=media`)).text(); },
    /** Replace content; returns new meta (version increases). */
    updateText: (id, text) => json(`${UPLOAD}/files/${id}?uploadType=media&fields=${META}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: text,
    }),
    /** Create a JSON file in the folder; returns meta. */
    async createText(folderId, name, text) {
      const boundary = `wb${Math.random().toString(36).slice(2)}`;
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId], mimeType: 'application/json', appProperties: { [APP_TAG]: 'file' } })}\r\n`
        + `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
      return json(`${UPLOAD}/files?uploadType=multipart&fields=${META}`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    },
  };
}
