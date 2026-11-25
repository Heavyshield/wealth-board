// "Données" window + header badge. Google Drive is the source of truth, without any Google sign-in:
//   Ouvrir     -> pick wealth-board.json (on a phone the picker offers Google Drive) -> loaded here
//   Enregistrer -> generate wealth-board.json -> share sheet (phone: "Enregistrer dans Drive")
//                  or download (computer: put it in the Drive folder)
// The browser keeps a working copy so the board opens instantly; the badge says when it differs from
// what was last saved.

import * as data from './data.js';
import { signIn, driveFiles, driveFolders } from './gdrive.js';

const META = 'wb.file'; // { name, opened_at, saved_at }
const when = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** ctx: { app, render, toast, dialog, badge, openButton }. Returns { afterLocalSave, updateBadge }. */
export function initDataUI({ app, render, toast, dialog, badge, openButton, openEditor }) {
  const meta = () => JSON.parse(localStorage.getItem(META) || '{}');
  const setMeta = (m) => localStorage.setItem(META, JSON.stringify({ ...meta(), ...m }));
  const unsaved = () => data.FILES.some((f) => data.readWorking(f)?.dirty);
  const isSample = () => app.files.portfolio.sample_data === true;
  const canShare = () => {
    try { return Boolean(navigator.canShare?.({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] })); } catch { return false; }
  };

  function updateBadge() {
    const m = meta();
    let text, warn = false;
    if (unsaved()) { text = 'Modifié · à enregistrer'; warn = true; }
    else if (isSample()) text = 'Données d’exemple';
    else text = `${m.saved_where === 'local' ? 'Enregistré (local)' : 'Enregistré'} ✓ ${when(m.saved_at ?? m.opened_at)}`;
    badge.textContent = text;
    badge.className = `sync-badge${warn ? ' warn' : ''}`;
  }

  // ------------------------------------------------------------------ open
  async function open(fileList) {
    const objects = [];
    for (const file of fileList) {
      try { objects.push({ name: file.name, obj: JSON.parse(await file.text()) }); } catch (e) { toast(`${file.name} : JSON illisible (${e.message})`, 'error'); }
    }
    return openObjects(objects, fileList.length > 1 ? `${fileList.length} fichiers` : fileList[0]?.name);
  }

  /** Validate + load opened objects. Returns true when loaded. */
  async function openObjects(objects, label, extraMeta = {}) {
    const { files, problems } = data.readOpened(objects);
    problems.forEach((p) => toast(p, 'error'));
    if (!Object.keys(files).length) return false;
    const errs = data.validateAll({ ...app.files, ...files }, app.schemas);
    const bad = Object.keys(files).filter((f) => errs[f]);
    if (bad.length) { toast(`Fichier refusé : ${bad[0]} · ${errs[bad[0]][0].path} : ${errs[bad[0]][0].message}`, 'error'); return false; }
    const older = files.portfolio && !isSample() && files.portfolio.revision < app.files.portfolio.revision;
    if (unsaved() && !confirm('Vos modifications ici ne sont pas encore enregistrées sur Drive. Les remplacer par ce fichier ?')) return false;
    if (older && !confirm(`Ce fichier (rév. ${files.portfolio.revision}) est plus ancien que les données affichées (rév. ${app.files.portfolio.revision}). L'ouvrir quand même ?`)) return false;
    for (const [f, d] of Object.entries(files)) { data.saveWorking(f, d, app.source[f].revision, { dirty: false }); app.files[f] = d; }
    setMeta({ name: label, opened_at: new Date().toISOString(), saved_at: null, drive_id: null, drive_version: null, ...extraMeta });
    render(); refresh();
    toast(`Ouvert : ${label} (portefeuille rév. ${app.files.portfolio.revision}).`);
    return true;
  }

  // ------------------------------------------------------------------ optional Drive login (computer)
  let session = null; // { token, expires } -- memory only
  // The user's own wealth-board.json carries its config (often without "drive"): fall back to the site's data/config.json.
  const clientId = () => app.files.config.drive?.client_id || app.source?.config?.drive?.client_id;
  const loggedIn = () => session && Date.now() < session.expires;
  // Folder holding wealth-board.json, chosen once per device: { id, path }. Ouvrir / Enregistrer only look there.
  const FOLDER_KEY = 'wb.drive_folder';
  const folder = () => JSON.parse(localStorage.getItem(FOLDER_KEY) || 'null');
  const files = (folderId = folder()?.id ?? null) => driveFiles(session.token, data.BUNDLE_NAME, undefined, folderId);

  /** Folder chooser shown in the Données dialog. Resolves { id, path } (saved for this device) or null (cancelled). */
  function pickFolder() {
    return new Promise((resolve) => {
      const api = driveFolders(session.token);
      let trail = [{ id: 'root', name: 'Mon Drive' }];
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        dialog.removeEventListener('close', onClose);
        if (v) localStorage.setItem(FOLDER_KEY, JSON.stringify(v));
        resolve(v);
      };
      const onClose = () => done(null);
      dialog.addEventListener('close', onClose);
      if (!dialog.open) dialog.showModal();

      async function draw() {
        const here = trail.at(-1);
        dialog.innerHTML = `<form method="dialog" class="editor data-dialog"><h2>Dossier Google Drive</h2>
          <p class="sub-title">Où ranger ${data.BUNDLE_NAME} ? « Ouvrir » et « Enregistrer » utiliseront ce dossier. Choix gardé sur cet appareil (modifiable dans Données).</p>
          <p><strong>${trail.map((t) => esc(t.name)).join(' / ')}</strong></p>
          <div class="folder-list"><p><span class="spinner" aria-hidden="true"></span> Chargement…</p></div>
          <div class="dialog-actions"><button type="button" data-cancel>Annuler</button>
            <button type="button" data-new>Nouveau dossier ici…</button>
            <button type="button" class="primary" data-pick>Choisir ce dossier</button></div></form>`;
        dialog.querySelector('[data-cancel]').addEventListener('click', () => done(null));
        dialog.querySelector('[data-pick]').addEventListener('click', () => done({ id: here.id, path: trail.map((t) => t.name).join(' / ') }));
        dialog.querySelector('[data-new]').addEventListener('click', async () => {
          const name = prompt('Nom du nouveau dossier :', 'Wealth Board')?.trim();
          if (!name) return;
          try { const made = await api.create(name, here.id); trail.push({ id: made.id, name: made.name }); draw(); }
          catch (e) { toast(e.message, 'error'); }
        });
        const list = dialog.querySelector('.folder-list');
        try {
          const [subs, copies] = await Promise.all([api.children(here.id), files(here.id).list()]);
          if (settled || trail.at(-1) !== here) return;
          list.innerHTML = `${copies.length
            ? `<p class="sub">Contient ${data.BUNDLE_NAME} (modifié le ${when(copies[0].modifiedTime)})${copies.length > 1 ? ` et ${copies.length - 1} autre(s) copie(s)` : ''}.</p>`
            : `<p class="sub">Pas de ${data.BUNDLE_NAME} ici : il sera créé au premier enregistrement.</p>`}
            <ul class="folder-items">
              ${trail.length > 1 ? '<li><button type="button" class="linklike" data-up>↑ Dossier parent</button></li>' : ''}
              ${subs.map((s) => `<li><button type="button" class="linklike" data-into="${esc(s.id)}" data-name="${esc(s.name)}">📁 ${esc(s.name)}</button></li>`).join('') || '<li class="sub">Aucun sous-dossier.</li>'}
            </ul>`;
          list.querySelector('[data-up]')?.addEventListener('click', () => { trail.pop(); draw(); });
          list.querySelectorAll('[data-into]').forEach((b) => b.addEventListener('click', () => { trail.push({ id: b.dataset.into, name: b.dataset.name }); draw(); }));
        } catch (e) {
          list.innerHTML = `<div class="errors"><p>${esc(e.message)}</p></div>`;
        }
      }

      // Start where the newest existing wealth-board.json lives, so the user sees where it landed so far.
      (async () => {
        try {
          const [existing] = await files(null).list();
          if (existing?.parents?.[0]) trail = await api.path(existing.parents[0]);
        } catch { /* start at My Drive */ }
        draw();
      })();
    });
  }
  const ensureFolder = async () => folder() ?? pickFolder();

  async function guard(fn) {
    try { await fn(); } catch (e) { toast(e.message, 'error'); if (/expirée/.test(e.message)) session = null; }
    updateBadge(); refresh();
  }
  const login = () => guard(async () => { session = await signIn(clientId()); toast('Connecté à Google Drive.'); });
  // (guard returns a promise: callers await login() then check loggedIn())
  const openDrive = () => guard(async () => {
    const dir = await ensureFolder();
    if (!dir) return;
    const all = await files().list();
    if (!all.length) { toast(`Aucun ${data.BUNDLE_NAME} dans « ${dir.path} » : enregistrez une première fois, ou changez de dossier (Données).`); return; }
    const [newest, ...older] = all;
    const obj = JSON.parse(await files().read(newest.id));
    const ok = await openObjects([{ name: newest.name, obj }], `Drive (${when(newest.modifiedTime)})`, { drive_id: newest.id, drive_version: newest.version });
    if (ok && older.length && confirm(`${all.length} copies de ${data.BUNDLE_NAME} sur Drive (enregistrements depuis le téléphone). La plus récente est ouverte. Mettre les ${older.length} autres à la corbeille de Drive (récupérables 30 jours) ?`)) {
      for (const o of older) await files().trash(o.id);
      toast(`${older.length} ancienne(s) copie(s) mise(s) à la corbeille.`);
    }
  });
  const saveDrive = () => guard(async () => {
    const dir = await ensureFolder();
    if (!dir) return;
    const text = data.makeBundle(app.files);
    const m = meta();
    let target = m.drive_id ? await files().meta(m.drive_id).catch(() => null) : null;
    if (target && !target.parents?.includes(dir.id)) target = null; // opened from another folder: save in the chosen one
    if (!target) target = (await files().list())[0] ?? null;
    if (target && String(target.version) !== String(m.drive_version ?? '')) {
      const who = target.lastModifyingUser?.displayName;
      if (!confirm(`${data.BUNDLE_NAME} sur Drive a été modifié le ${when(target.modifiedTime)}${who ? ` (${who})` : ''} depuis votre ouverture. Le remplacer par la version affichée ici ?\n(Annuler, puis « Ouvrir depuis Drive » pour récupérer l'autre version.)`)) return;
    }
    const saved = target ? await files().update(target.id, text) : await files().create(text);
    for (const f of data.FILES) data.saveWorking(f, app.files[f], app.source[f].revision, { dirty: false });
    setMeta({ saved_at: new Date().toISOString(), drive_id: saved.id, drive_version: saved.version });
    toast(target ? `${data.BUNDLE_NAME} remplacé dans « ${dir.path} » (version précédente gardée dans l'historique Drive).` : `${data.BUNDLE_NAME} créé dans « ${dir.path} ».`);
  });

  // ------------------------------------------------------------------ save
  // Phone = touch screen + share sheet with files: the share sheet offers "Enregistrer dans Drive".
  const isPhone = () => matchMedia('(pointer: coarse)').matches && canShare();
  const DRIVE_SEARCH = `https://drive.google.com/drive/search?q=${encodeURIComponent(data.BUNDLE_NAME)}`;

  function markSaved(where) {
    for (const f of data.FILES) data.saveWorking(f, app.files[f], app.source[f].revision, { dirty: false });
    setMeta({ saved_at: new Date().toISOString(), saved_where: where });
    updateBadge(); refresh();
  }

  function saveLocal() {
    data.downloadText(data.BUNDLE_NAME, data.makeBundle(app.files));
    markSaved('local');
    toast(`${data.BUNDLE_NAME} téléchargé (dossier Téléchargements).`);
  }

  async function saveToDrive() {
    if (clientId()) { if (!loggedIn()) await login(); if (loggedIn()) await saveDrive(); return; }
    const text = data.makeBundle(app.files);
    if (isPhone()) {
      try { await navigator.share({ files: [new File([text], data.BUNDLE_NAME, { type: 'application/json' })], title: 'Wealth Board' }); }
      catch (e) { if (e.name === 'AbortError') { toast('Enregistrement annulé : rien n’a été marqué comme enregistré.'); return; } throw e; }
      markSaved('drive');
      toast('Choisissez « Enregistrer dans Drive » → dossier Wealth Board, puis supprimez l’ancienne copie.');
      return;
    }
    // Computer without Google login: download, then replace the file in Drive (keeps one file, Drive keeps history).
    data.downloadText(data.BUNDLE_NAME, text);
    window.open(DRIVE_SEARCH, '_blank', 'noopener');
    markSaved('drive');
    showHelp('save');
  }

  function openFromDrive() {
    if (clientId()) { (loggedIn() ? Promise.resolve() : login()).then(() => loggedIn() && openDrive()); return; }
    if (isPhone()) { dialog.querySelector('[data-open]').click(); return; } // the phone picker lists Google Drive
    showHelp('open');
  }

  function showHelp(kind) {
    const el = dialog.querySelector('.drive-help');
    if (!el) return;
    el.hidden = false;
    el.innerHTML = kind === 'open'
      ? `<strong>Ouvrir depuis Google Drive sur ordinateur :</strong> ouvrez <a href="${DRIVE_SEARCH}" target="_blank" rel="noopener">${data.BUNDLE_NAME} dans Drive</a>
         → Télécharger, puis « Fichier local… » ci-dessous. Avec Google Drive pour ordinateur, « Fichier local… » peut aussi le prendre directement dans le lecteur Google Drive.`
      : `<strong>Dernière étape dans l’onglet Drive qui vient de s’ouvrir :</strong> clic droit sur ${data.BUNDLE_NAME} → Informations sur le fichier → <em>Gérer les versions</em>
         → Importer une nouvelle version → le fichier téléchargé. (Première fois : glissez simplement le fichier dans Drive.)`;
  }

  // ------------------------------------------------------------------ window
  function refresh() {
    if (!dialog.open) return;
    const m = meta();
    const share = canShare();
    dialog.innerHTML = `<form method="dialog" class="editor data-dialog">
      <h2>Données</h2>
      <p class="sub-title">Vos données vivent dans <strong>${data.BUNDLE_NAME}</strong> sur Google Drive. Ce navigateur en garde une copie pour s'ouvrir vite.</p>
      <p>${isSample() ? 'Affiché : <strong>données d’exemple</strong>.'
        : `Affiché : portefeuille rév. ${app.files.portfolio.revision}${m.name ? ` · ouvert depuis ${esc(m.name)} le ${when(m.opened_at)}` : ''}${m.saved_at ? ` · enregistré le ${when(m.saved_at)}` : ''}.`}
        ${unsaved() ? '<br><strong>Modifications non enregistrées sur Drive.</strong>' : ''}</p>
      <h3>Ouvrir</h3>
      <div class="data-steps">
        <button type="button" class="primary" data-open-drive>Depuis Google Drive${clientId() && !loggedIn() ? ' (connexion)' : ''}</button>
        <label class="button-like">Fichier local…<input type="file" accept=".json,application/json" multiple data-open hidden></label>
      </div>
      <h3>Enregistrer</h3>
      <div class="data-steps">
        <button type="button" class="primary" data-save-drive>Sur Google Drive</button>
        <button type="button" data-save-local>Fichier local (télécharger)</button>
      </div>
      <p class="sub drive-help" hidden></p>
      ${clientId() ? `<p>Dossier Drive : <strong>${folder() ? esc(folder().path) : 'pas encore choisi (demandé au premier usage)'}</strong>
        <button type="button" class="linklike" data-folder>${folder() ? 'Changer' : 'Choisir'}</button></p>` : ''}
      <p class="sub">${clientId() ? 'Connecté à Google, le fichier est lu et remplacé directement dans ce dossier Drive.'
        : isPhone() ? 'Sur téléphone, Google Drive apparaît dans le sélecteur de fichiers et dans le menu de partage.'
        : 'Sur ordinateur, sans connexion Google, le site ne peut pas lire Drive lui-même : une étape manuelle est expliquée au clic.'}</p>
      <h3>Éditeur de données</h3>
      <div class="data-steps"><button type="button" data-edit-json="lines">Ajouter des lignes (JSON)…</button>
        <button type="button" data-edit-json="full">Modifier le fichier complet…</button></div>
      <details><summary>Autres actions</summary>
        <div class="dialog-actions start">
          ${data.FILES.map((f) => `<button type="button" data-export="${f}">Télécharger ${f}.json seul</button>`).join('')}
          <button type="button" class="danger" data-reset>Effacer la copie de ce navigateur</button>
        </div>
      </details>
      <div class="dialog-actions"><button type="button" data-close>Fermer</button></div></form>`;
    dialog.querySelector('[data-open]').addEventListener('change', (e) => open(e.target.files));
    dialog.querySelector('[data-open-drive]').addEventListener('click', openFromDrive);
    dialog.querySelector('[data-save-drive]').addEventListener('click', () => saveToDrive().catch((e) => toast(e.message, 'error')));
    dialog.querySelector('[data-save-local]').addEventListener('click', saveLocal);
    dialog.querySelector('[data-folder]')?.addEventListener('click', () => (loggedIn() ? Promise.resolve() : login())
      .then(() => loggedIn() && guard(async () => { const d = await pickFolder(); if (d) toast(`Dossier Drive : ${d.path}`); })));
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.querySelectorAll('[data-edit-json]').forEach((b) => b.addEventListener('click', () => { dialog.close(); openEditor?.(b.dataset.editJson); }));
    dialog.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => data.downloadJson(b.dataset.export, app.files[b.dataset.export])));
    dialog.querySelector('[data-reset]').addEventListener('click', () => {
      if (!confirm(unsaved() ? 'Des modifications ne sont pas enregistrées sur Drive. Effacer quand même ?' : 'Effacer la copie de ce navigateur ? Il faudra rouvrir le fichier depuis Drive.')) return;
      data.FILES.forEach(data.dropWorking);
      ['wb.file', 'wb.drive', 'wb.folder', 'wb.source', FOLDER_KEY].forEach((k) => localStorage.removeItem(k));
      location.reload();
    });
  }

  const show = () => { dialog.showModal(); refresh(); };
  openButton.addEventListener('click', show);
  badge.addEventListener('click', show);
  ['wb.drive', 'wb.folder', 'wb.source'].forEach((k) => localStorage.removeItem(k)); // leftovers of the removed OAuth sync
  updateBadge();
  return { afterLocalSave: updateBadge, updateBadge };
}
