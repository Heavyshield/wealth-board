// "Données & synchro" dialog + header badge + conflict dialog.
// Sources (one at a time, localStorage wb.source): repo (sample/defaults) | drive | folder.
// Fallbacks always available: JSON export/import per file.

import * as data from './data.js';
import { createTokenProvider, createDriveClient, DriveError } from './drive.js';
import { createSync, summarizeDiff, pretty } from './sync.js';
import { folderSupported, pickFolder, getFolder, folderName, readFolder, lastModified, writeFile } from './folder.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LABEL = { portfolio: 'portfolio.json', config: 'config.json', history: 'history.json' };
const time = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const DRIVE_STATE = 'wb.drive';
const FOLDER_STATE = 'wb.folder';

/**
 * ctx: { app, render, toast, dialog, conflictDialog, badge, openButton }
 * Returns { afterLocalSave(file) } -- call after every local save so changes reach Drive.
 */
export function initDataUI(ctx) {
  const { app, render, toast, dialog, conflictDialog, badge, openButton } = ctx;
  const driveCfg = () => app.files.config.drive ?? {};
  let tokens = null, sync = null, busy = false, lastError = null;
  const pushTimers = {};

  // ---------------------------------------------------------------- local copy adapters
  const getLocal = (f) => {
    const w = data.readWorking(f);
    // A record without `dirty` predates sync: treat as unsent local changes (safe: may ask, never loses).
    return w ? { data: w.data, dirty: w.dirty !== false, drive_version: w.drive_version } : { data: app.files[f], dirty: false };
  };
  const setLocal = (f, d, extra) => { data.saveWorking(f, d, app.source[f].revision, extra); app.files[f] = d; };
  const validateFile = (f, d) => data.validateAll({ ...app.files, [f]: d }, app.schemas)[f] ?? [];
  const dirtyFiles = () => data.FILES.filter((f) => data.readWorking(f)?.dirty !== false && data.readWorking(f));

  // ---------------------------------------------------------------- conflict dialog
  function resolveConflict({ file, mine, theirs, meta, reason, where = 'Drive' }) {
    return new Promise((resolve) => {
      const invalid = reason && reason !== 'both';
      const who = meta?.lastModifyingUser?.displayName;
      conflictDialog.innerHTML = `<form method="dialog" class="editor">
        <h2>Conflit sur ${esc(LABEL[file])}</h2>
        <p>${invalid
          ? `Le fichier sur ${where} ne peut pas être utilisé : <strong>${esc(reason)}</strong>. Il n'a pas été modifié.`
          : `Ce fichier a changé sur ${where}${meta?.modifiedTime ? ` (${time(meta.modifiedTime)}${who ? `, ${esc(who)}` : ''})` : ''} et vous avez aussi des modifications ici non envoyées.`}
          Rien n'est écrasé sans votre choix.</p>
        <details ${invalid ? '' : 'open'}><summary>Voir les différences</summary><ul class="diff-list">${summarizeDiff(mine, theirs).slice(0, 60).map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>
        <div class="dialog-actions">
          <button type="button" data-choice="later">Décider plus tard</button>
          <button type="button" data-choice="download">Télécharger ma version</button>
          ${invalid ? '' : `<button type="button" data-choice="theirs">Garder celle de ${where}</button>`}
          <button type="button" class="primary" data-choice="mine">Garder la mienne</button>
        </div></form>`;
      conflictDialog.querySelectorAll('[data-choice]').forEach((b) => b.addEventListener('click', () => {
        const c = b.dataset.choice;
        if (c === 'download') { data.downloadJson(`${file}.mine`, mine); return; }
        if (c === 'mine' && !confirm(`Remplacer ${LABEL[file]} sur ${where} par votre version ?`)) return;
        conflictDialog.close();
        resolve(c === 'later' ? null : c);
      }));
      conflictDialog.addEventListener('cancel', () => resolve(null), { once: true });
      conflictDialog.showModal();
    });
  }

  // ---------------------------------------------------------------- Drive
  function ensureSync() {
    if (sync) return sync;
    tokens = createTokenProvider(driveCfg().client_id);
    const client = createDriveClient({ getToken: () => tokens.get(), onUnauthorized: () => tokens.invalidate() });
    sync = createSync({
      client, files: data.FILES, folderName: driveCfg().folder_name ?? 'Wealth Board',
      state: { load: () => JSON.parse(localStorage.getItem(DRIVE_STATE) || 'null'), save: (s) => localStorage.setItem(DRIVE_STATE, JSON.stringify(s)) },
      getLocal, setLocal, validate: validateFile, resolveConflict,
    });
    return sync;
  }

  const OUTCOME = { created: 'créé sur Drive', pushed: 'envoyé', pulled: 'mis à jour depuis Drive', same: 'à jour', 'kept-mine': 'votre version gardée', 'kept-theirs': 'version Drive gardée', unresolved: 'conflit non résolu' };
  const summary = (rep) => Object.entries(rep).map(([f, o]) => `${LABEL[f]} : ${OUTCOME[o] ?? o}`).join(' · ');

  async function run(label, fn) {
    if (busy) return;
    busy = true; lastError = null; updateBadge(label); refreshDialog();
    try { await fn(); } catch (e) {
      lastError = e instanceof DriveError ? e.message : `${e.message}`;
      toast(lastError, 'error'); console.error(e);
    } finally { busy = false; render(); updateBadge(); refreshDialog(); }
  }

  const connectDrive = () => run('Connexion à Drive…', async () => {
    const s = ensureSync();
    await tokens.get({ interactive: true });
    const rep = await s.connect();
    data.setSource('drive');
    toast(`Drive connecté. ${summary(rep)}`);
  });
  const syncNow = () => run('Synchronisation…', async () => {
    const s = ensureSync();
    if (!tokens.hasToken) await tokens.get({ interactive: true });
    const rep = {};
    for (const f of data.FILES) rep[f] = await s.push(f);
    Object.assign(rep, await s.pull());
    toast(`Synchronisé. ${summary(rep)}`);
  });
  const reloadDrive = () => run('Lecture de Drive…', async () => {
    const s = ensureSync();
    if (!tokens.hasToken) await tokens.get({ interactive: true });
    toast(`Relu depuis Drive. ${summary(await s.pull())}`);
  });
  function disconnectDrive() {
    if (!confirm('Déconnecter Google Drive ? Vos données restent dans ce navigateur et sur Drive.')) return;
    tokens?.revoke(); sync = null; tokens = null;
    localStorage.removeItem(DRIVE_STATE);
    data.setSource('repo');
    updateBadge(); refreshDialog();
  }

  /** Called after every local save: send to Drive in the background (debounced). */
  function afterLocalSave(file) {
    updateBadge();
    if (data.getSource() !== 'drive' || !tokens?.hasToken) return;
    clearTimeout(pushTimers[file]);
    pushTimers[file] = setTimeout(() => run('Envoi vers Drive…', async () => {
      const out = await ensureSync().push(file);
      if (out === 'unresolved') toast(`${LABEL[file]} : conflit non résolu, rien n'a été envoyé.`, 'error');
    }), 1200);
  }

  // Pick up edits made elsewhere (Claude, phone) when coming back to the tab -- only with a valid token.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && data.getSource() === 'drive' && tokens?.hasToken && !busy) {
      run('Vérification de Drive…', async () => {
        const rep = await ensureSync().pull();
        if (Object.values(rep).some((o) => o !== 'same')) toast(`Drive : ${summary(rep)}`);
      });
    }
  });

  // ---------------------------------------------------------------- local folder
  const folderState = () => JSON.parse(localStorage.getItem(FOLDER_STATE) || '{}');
  const saveFolderState = (s) => localStorage.setItem(FOLDER_STATE, JSON.stringify(s));

  const chooseFolder = () => run('Choix du dossier…', async () => { await pickFolder(); await loadFolder(true); });
  async function loadFolder(inner = false) {
    const go = async () => {
      const handle = await getFolder();
      if (!handle) throw new Error('Dossier non autorisé : choisissez-le à nouveau.');
      const found = await readFolder(handle, data.FILES);
      const st = folderState();
      for (const f of data.FILES) {
        const r = found[f];
        if (!r) continue;
        const errs = r.data ? validateFile(f, r.data) : [];
        const local = getLocal(f);
        if (r.error || errs.length) {
          await resolveConflict({ file: f, mine: local.data, theirs: r.data, reason: r.error ?? `${errs[0].path} : ${errs[0].message}`, where: 'le dossier' });
          continue;
        }
        if (local.dirty && JSON.stringify(local.data) !== JSON.stringify(r.data)) {
          const c = await resolveConflict({ file: f, mine: local.data, theirs: r.data, meta: { modifiedTime: new Date(r.lastModified).toISOString() }, reason: 'both', where: 'le dossier' });
          if (c !== 'theirs') continue;
        }
        setLocal(f, r.data, { dirty: false });
        st[f] = r.lastModified;
      }
      saveFolderState(st);
      data.setSource('folder');
      toast(`Dossier « ${handle.name} » chargé (${Object.keys(found).length} fichier(s)).`);
    };
    return inner ? go() : run('Lecture du dossier…', go);
  }
  const saveFolder = () => run('Écriture dans le dossier…', async () => {
    const handle = await getFolder();
    if (!handle) throw new Error('Dossier non autorisé : choisissez-le à nouveau.');
    const st = folderState();
    let n = 0;
    for (const f of data.FILES) {
      const lm = await lastModified(handle, f);
      if (lm && st[f] && lm !== st[f]) { // changed on disk since we read/wrote it (Drive sync, Claude...)
        const theirs = (await readFolder(handle, [f]))[f];
        const c = await resolveConflict({ file: f, mine: app.files[f], theirs: theirs?.data, meta: { modifiedTime: new Date(lm).toISOString() }, reason: theirs?.error ?? 'both', where: 'le dossier' });
        if (c === 'theirs') { setLocal(f, theirs.data, { dirty: false }); st[f] = lm; continue; }
        if (c !== 'mine') continue;
      }
      st[f] = await writeFile(handle, f, pretty(app.files[f]));
      setLocal(f, app.files[f], { dirty: false });
      n++;
    }
    saveFolderState(st);
    toast(`${n} fichier(s) écrit(s) dans « ${handle.name} ».`);
  });

  // ---------------------------------------------------------------- JSON files
  function detect(obj) {
    if (Array.isArray(obj?.holdings)) return 'portfolio';
    if (Array.isArray(obj?.envelopes)) return 'config';
    if (Array.isArray(obj?.snapshots)) return 'history';
    return null;
  }
  async function importJson(fileList) {
    for (const file of fileList) {
      let obj;
      try { obj = JSON.parse(await file.text()); } catch (e) { toast(`${file.name} : JSON illisible (${e.message})`, 'error'); continue; }
      const f = detect(obj);
      if (!f) { toast(`${file.name} : type de fichier non reconnu`, 'error'); continue; }
      const errs = validateFile(f, obj);
      if (errs.length) { toast(`${file.name} refusé : ${errs[0].path} : ${errs[0].message}`, 'error'); continue; }
      if (!confirm(`Remplacer ${LABEL[f]} (rév. ${app.files[f].revision}) par ${file.name} (rév. ${obj.revision}) ?`)) continue;
      setLocal(f, obj, { dirty: true });
      afterLocalSave(f);
      toast(`${LABEL[f]} remplacé par ${file.name}.`);
    }
    render(); refreshDialog();
  }

  // ---------------------------------------------------------------- badge + dialog
  function updateBadge(progress) {
    const src = data.getSource();
    const dirty = dirtyFiles().length;
    const st = JSON.parse(localStorage.getItem(DRIVE_STATE) || 'null');
    let text, cls = '';
    if (progress) text = progress;
    else if (src === 'drive') {
      if (!tokens?.hasToken) { text = dirty ? `Drive · ${dirty} non envoyé(s) · reconnecter` : 'Drive · reconnecter'; cls = 'warn'; }
      else if (dirty) { text = `Drive · ${dirty} non envoyé(s)`; cls = 'warn'; }
      else text = `Drive ✓ ${time(st?.last_sync)}`;
    } else if (src === 'folder') text = dirty ? `Dossier · ${dirty} non enregistré(s)` : 'Dossier local ✓';
    else text = dirty ? 'Navigateur seulement · non sauvegardé' : 'Données d’exemple';
    if (lastError && !progress) { text = `⚠ ${text}`; cls = 'warn'; }
    badge.textContent = text;
    badge.className = `sync-badge ${cls}`;
  }

  function refreshDialog() {
    if (!dialog.open) return;
    const src = data.getSource();
    const cid = driveCfg().client_id;
    const st = JSON.parse(localStorage.getItem(DRIVE_STATE) || 'null');
    const dirty = dirtyFiles();
    dialog.innerHTML = `<form method="dialog" class="editor data-dialog">
      <h2>Données & synchronisation</h2>
      <p class="sub-title">Source actuelle : <strong>${{ drive: 'Google Drive', folder: 'dossier local', repo: 'ce navigateur (exemple par défaut)' }[src]}</strong>
        ${dirty.length ? ` · non envoyé : ${dirty.map((f) => LABEL[f]).join(', ')}` : ''}</p>
      ${lastError ? `<p class="errors">${esc(lastError)}</p>` : ''}
      <section><h3>Google Drive</h3>
        ${!cid ? '<p>Non configuré : ajoutez votre « client ID » OAuth dans <code>config.json → drive.client_id</code> (voir README, section Google Drive).</p>'
          : `<p class="sub">Dossier « ${esc(driveCfg().folder_name ?? 'Wealth Board')} » créé par l'application (accès limité à ses propres fichiers).
              ${st?.last_sync ? `Dernière synchro : ${time(st.last_sync)}.` : ''}</p>
            <div class="dialog-actions start">
              ${src === 'drive'
                ? `<button type="button" data-a="sync" class="primary">${tokens?.hasToken ? 'Synchroniser maintenant' : 'Reconnecter et synchroniser'}</button>
                   <button type="button" data-a="reload">Relire depuis Drive</button><button type="button" data-a="disconnect">Déconnecter</button>`
                : '<button type="button" data-a="connect" class="primary">Connecter Google Drive</button>'}
            </div>`}
      </section>
      <section><h3>Dossier local</h3>
        ${folderSupported()
          ? `<p class="sub">Ex. un dossier synchronisé par Google Drive pour ordinateur. Chrome / Edge sur ordinateur uniquement.</p>
             <div class="dialog-actions start"><button type="button" data-a="pick-folder">Choisir un dossier…</button>
             <button type="button" data-a="load-folder">Charger depuis le dossier</button><button type="button" data-a="save-folder">Enregistrer dans le dossier</button></div>
             <p class="sub" data-folder-name></p>`
          : '<p class="sub">Non disponible dans ce navigateur (Chrome ou Edge sur ordinateur).</p>'}
      </section>
      <section><h3>Fichiers JSON</h3>
        <div class="dialog-actions start">
          ${data.FILES.map((f) => `<button type="button" data-export="${f}">Exporter ${LABEL[f]}</button>`).join('')}
          <label class="button-like">Importer des fichiers JSON…<input type="file" accept=".json,application/json" multiple data-import hidden></label>
        </div>
      </section>
      <section><h3>Copie locale</h3>
        <div class="dialog-actions start"><button type="button" class="danger" data-a="reset">Effacer la copie locale de ce navigateur</button></div>
      </section>
      <div class="dialog-actions"><button type="button" data-close class="primary">Fermer</button></div></form>`;
    folderName().then((n) => { const el = dialog.querySelector('[data-folder-name]'); if (el && n) el.textContent = `Dossier mémorisé : ${n}`; }).catch(() => {});
    const on = (sel, fn) => dialog.querySelector(sel)?.addEventListener('click', fn);
    on('[data-close]', () => dialog.close());
    on('[data-a="connect"]', connectDrive);
    on('[data-a="sync"]', syncNow);
    on('[data-a="reload"]', reloadDrive);
    on('[data-a="disconnect"]', disconnectDrive);
    on('[data-a="pick-folder"]', chooseFolder);
    on('[data-a="load-folder"]', () => loadFolder());
    on('[data-a="save-folder"]', saveFolder);
    on('[data-a="reset"]', () => {
      const msg = dirty.length ? `Attention : ${dirty.map((f) => LABEL[f]).join(', ')} n'ont été envoyés nulle part. Effacer quand même ?` : 'Effacer la copie locale et recharger ?';
      if (!confirm(msg)) return;
      data.FILES.forEach(data.dropWorking);
      localStorage.removeItem(DRIVE_STATE); localStorage.removeItem(FOLDER_STATE); data.setSource('repo');
      location.reload();
    });
    dialog.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => data.downloadJson(b.dataset.export, app.files[b.dataset.export])));
    dialog.querySelector('[data-import]').addEventListener('change', (e) => importJson(e.target.files));
  }

  openButton.addEventListener('click', () => { dialog.showModal(); refreshDialog(); });
  badge.addEventListener('click', () => { dialog.showModal(); refreshDialog(); });
  updateBadge();
  return { afterLocalSave, updateBadge };
}
