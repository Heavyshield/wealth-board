// "Données" window + header badge. Google Drive is the source of truth, without any Google sign-in:
//   Ouvrir     -> pick wealth-board.json (on a phone the picker offers Google Drive) -> loaded here
//   Enregistrer -> generate wealth-board.json -> share sheet (phone: "Enregistrer dans Drive")
//                  or download (computer: put it in the Drive folder)
// The browser keeps a working copy so the board opens instantly; the badge says when it differs from
// what was last saved.

import * as data from './data.js';

const META = 'wb.file'; // { name, opened_at, saved_at }
const when = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** ctx: { app, render, toast, dialog, badge, openButton }. Returns { afterLocalSave, updateBadge }. */
export function initDataUI({ app, render, toast, dialog, badge, openButton }) {
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
    if (unsaved()) { text = 'Modifié · à enregistrer sur Drive'; warn = true; }
    else if (isSample()) text = 'Données d’exemple';
    else text = `Drive ✓ ${when(m.saved_at ?? m.opened_at)}`;
    badge.textContent = text;
    badge.className = `sync-badge${warn ? ' warn' : ''}`;
  }

  // ------------------------------------------------------------------ open
  async function open(fileList) {
    const objects = [];
    for (const file of fileList) {
      try { objects.push({ name: file.name, obj: JSON.parse(await file.text()) }); } catch (e) { toast(`${file.name} : JSON illisible (${e.message})`, 'error'); }
    }
    const { files, problems } = data.readOpened(objects);
    problems.forEach((p) => toast(p, 'error'));
    if (!Object.keys(files).length) return;
    const errs = data.validateAll({ ...app.files, ...files }, app.schemas);
    const bad = Object.keys(files).filter((f) => errs[f]);
    if (bad.length) { toast(`Fichier refusé : ${bad[0]} · ${errs[bad[0]][0].path} : ${errs[bad[0]][0].message}`, 'error'); return; }
    const older = files.portfolio && !isSample() && files.portfolio.revision < app.files.portfolio.revision;
    if (unsaved() && !confirm('Vos modifications ici ne sont pas encore enregistrées sur Drive. Les remplacer par ce fichier ?')) return;
    if (older && !confirm(`Ce fichier (rév. ${files.portfolio.revision}) est plus ancien que les données affichées (rév. ${app.files.portfolio.revision}). L'ouvrir quand même ?`)) return;
    for (const [f, d] of Object.entries(files)) { data.saveWorking(f, d, app.source[f].revision, { dirty: false }); app.files[f] = d; }
    setMeta({ name: fileList[0].name, opened_at: new Date().toISOString(), saved_at: null });
    render(); refresh();
    toast(`Ouvert : ${fileList.length > 1 ? `${fileList.length} fichiers` : fileList[0].name} (portefeuille rév. ${app.files.portfolio.revision}).`);
  }

  // ------------------------------------------------------------------ save
  async function save() {
    const text = data.makeBundle(app.files);
    const file = new File([text], data.BUNDLE_NAME, { type: 'application/json' });
    try {
      if (canShare()) await navigator.share({ files: [file], title: 'Wealth Board' });
      else data.downloadText(data.BUNDLE_NAME, text);
    } catch (e) {
      if (e.name === 'AbortError') { toast('Enregistrement annulé : rien n’a été marqué comme enregistré.'); return; }
      data.downloadText(data.BUNDLE_NAME, text); // share failed for another reason: fall back to a download
    }
    for (const f of data.FILES) data.saveWorking(f, app.files[f], app.source[f].revision, { dirty: false });
    setMeta({ saved_at: new Date().toISOString() });
    updateBadge(); refresh();
    toast(canShare() ? 'Fichier partagé : choisissez « Enregistrer dans Drive ».' : `${data.BUNDLE_NAME} téléchargé : déposez-le dans votre dossier Drive (en remplaçant l’ancien).`);
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
      <div class="data-steps">
        <label class="button-like primary-like">1. Ouvrir depuis Drive…<input type="file" accept=".json,application/json" multiple data-open hidden></label>
        <button type="button" class="primary" data-save>2. Enregistrer sur Drive${share ? ' (partager)' : ' (télécharger)'}</button>
      </div>
      <p class="sub">${share
        ? 'Ouvrir : choisissez Google Drive dans le sélecteur. Enregistrer : dans le menu de partage, « Enregistrer dans Drive », dossier Wealth Board. Supprimez ensuite l’ancienne copie pour n’en garder qu’une.'
        : 'Enregistrer télécharge le fichier : déposez-le dans votre dossier Drive (Google Drive pour ordinateur ou drive.google.com) en remplaçant l’ancien.'}</p>
      <details><summary>Autres actions</summary>
        <div class="dialog-actions start">
          ${data.FILES.map((f) => `<button type="button" data-export="${f}">Télécharger ${f}.json seul</button>`).join('')}
          <button type="button" class="danger" data-reset>Effacer la copie de ce navigateur</button>
        </div>
      </details>
      <div class="dialog-actions"><button type="button" data-close>Fermer</button></div></form>`;
    dialog.querySelector('[data-open]').addEventListener('change', (e) => open(e.target.files));
    dialog.querySelector('[data-save]').addEventListener('click', save);
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => data.downloadJson(b.dataset.export, app.files[b.dataset.export])));
    dialog.querySelector('[data-reset]').addEventListener('click', () => {
      if (!confirm(unsaved() ? 'Des modifications ne sont pas enregistrées sur Drive. Effacer quand même ?' : 'Effacer la copie de ce navigateur ? Il faudra rouvrir le fichier depuis Drive.')) return;
      data.FILES.forEach(data.dropWorking);
      ['wb.file', 'wb.drive', 'wb.folder', 'wb.source'].forEach((k) => localStorage.removeItem(k));
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
