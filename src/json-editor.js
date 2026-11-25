// Éditeur Données: paste JSON to add/update lines (e.g. lines prepared by Claude), or edit the whole file.
//   - fragment { "holdings": [...], "envelopes": [...], "asset_classes": [...] } or a bare array of lines
//     -> merged by id (new = added, existing = updated field by field), every change logged
//   - full wealth-board.json ({ "format": "wealth-board/1", ... }) -> replaces everything
// Always: Vérifier (validation + summary) before Appliquer. Nothing applied on error.

import * as data from './data.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TEMPLATE = `{
  "holdings": [
    {
      "id": "metals-exemple-piece",
      "name": "Nom de la ligne",
      "envelope": "id d'une enveloppe de config",
      "asset_class": "metal",
      "quantity": 10,
      "unit_cost": null,
      "currency": "EUR",
      "price_source": "spot",
      "metal": { "code": "XAG", "weight": 31.1035, "unit": "g", "purity": 0.999 },
      "as_of": "${new Date().toISOString().slice(0, 10)}",
      "tags": [],
      "notes": ""
    }
  ]
}`;

/** ctx: { dialog, getFiles, schemas, commitFiles(nextFiles, message) -> bool } */
export function createJsonEditor({ dialog, getFiles, schemas, commitFiles }) {
  let pending = null;

  function check(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return { error: `JSON illisible : ${e.message}` }; }
    const files = getFiles();
    if (obj?.format === data.BUNDLE_FORMAT) {
      const { files: opened } = data.readOpened([{ name: 'editeur', obj }]);
      const next = { ...files, ...opened };
      return { mode: 'full', next, summary: [`Remplacement complet : ${next.portfolio.holdings.length} ligne(s) (actuellement ${files.portfolio.holdings.length}).`] };
    }
    const r = data.mergeFragment(files, obj, 'user');
    const summary = [
      r.added.length ? `Ajout : ${r.added.join(', ')}` : null,
      r.updated.length ? `Mise à jour : ${r.updated.join(', ')}` : null,
      r.removed.length ? `Suppression : ${r.removed.join(', ')}` : null,
      r.unchanged.length ? `Inchangé : ${r.unchanged.length}` : null,
    ].filter(Boolean);
    if (!r.added.length && !r.updated.length && !r.removed.length) summary.push('Aucun changement.');
    return { mode: 'merge', next: r.files, summary, problems: r.problems };
  }

  function open(prefill = 'lines') {
    const files = getFiles();
    const text = prefill === 'full' ? data.makeBundle(files) : TEMPLATE;
    dialog.innerHTML = `<form method="dialog" class="editor json-editor">
      <h2>Éditeur de données (JSON)</h2>
      <p class="sub-title">Collez des lignes à ajouter ou mettre à jour (par <code>id</code>), par exemple préparées par Claude,
        ou modifiez le fichier complet. Chaque ligne a une date <code>as_of</code>. Montant inconnu : <code>"quantity": null</code> (affiché « à compléter »).</p>
      <div class="seg-control" role="radiogroup" aria-label="Contenu">
        <button type="button" role="radio" data-prefill="lines" aria-checked="${prefill === 'lines'}">Ajouter des lignes</button>
        <button type="button" role="radio" data-prefill="full" aria-checked="${prefill === 'full'}">Fichier complet</button>
      </div>
      <textarea class="export-text" rows="18" spellcheck="false" aria-label="JSON">${esc(text)}</textarea>
      <div class="je-result" aria-live="polite"></div>
      <details><summary>Enveloppes et classes disponibles</summary><p class="sub">
        Enveloppes : ${files.config.envelopes.map((e) => `<code>${esc(e.id)}</code>`).join(' ')}<br>
        Classes : ${files.config.asset_classes.map((c) => `<code>${esc(c.id)}</code> (${esc(c.pricing)})`).join(' ')}<br>
        Une nouvelle enveloppe peut être ajoutée dans le même collage : <code>"envelopes": [{ "id": "…", "label": "…", "in_net_worth": false }]</code>.</p></details>
      <div class="dialog-actions"><button type="button" data-close>Fermer</button>
        <button type="button" data-check>Vérifier</button><button type="button" class="primary" data-apply disabled>Appliquer</button></div></form>`;
    const ta = dialog.querySelector('textarea');
    const out = dialog.querySelector('.je-result');
    const applyBtn = dialog.querySelector('[data-apply]');
    ta.addEventListener('input', () => { pending = null; applyBtn.disabled = true; out.innerHTML = ''; });
    dialog.querySelectorAll('[data-prefill]').forEach((b) => b.addEventListener('click', () => open(b.dataset.prefill)));
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-check]').addEventListener('click', () => {
      const r = check(ta.value);
      pending = null; applyBtn.disabled = true;
      if (r.error) { out.innerHTML = `<p class="errors">${esc(r.error)}</p>`; return; }
      const errs = data.validateAll(r.next, schemas);
      const errList = Object.entries(errs).flatMap(([f, es]) => es.slice(0, 8).map((e) => `${f} · ${e.path} : ${e.message}`));
      out.innerHTML = `<ul class="je-summary">${r.summary.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        ${r.problems?.length ? `<div class="import-problems"><p>Ignoré :</p><ul>${r.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
        ${errList.length ? `<div class="errors"><p>Erreurs (rien ne sera appliqué) :</p><ul>${errList.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}`;
      if (!errList.length && !/Aucun changement/.test(r.summary.join())) { pending = r; applyBtn.disabled = false; }
    });
    applyBtn.addEventListener('click', () => {
      if (!pending) return;
      if (pending.mode === 'full' && !confirm('Remplacer toutes les données affichées par ce contenu ?')) return;
      if (commitFiles(pending.next, pending.mode === 'full' ? 'Données remplacées' : `Lignes intégrées (${pending.summary.join(' · ')})`)) dialog.close();
    });
    if (!dialog.open) dialog.showModal();
  }
  return { open };
}
