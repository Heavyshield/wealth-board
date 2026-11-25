// Import dialog: pick profile + envelope + CSV file -> show detected format, column mapping,
// problems and the diff (each line has a checkbox) -> apply only what is ticked.
// The file is read locally in the browser; nothing is uploaded anywhere. Lines without ticker
// (new or already there) get one suggested from their ISIN through the user's Yahoo proxy (/search),
// shown as ticked lines in the same dialog, so PER / ratios can be fetched afterwards.

import * as fmt from './format.js';
import { decode, dateFromFileName } from './csv.js';
import { readPositions, diffPositions, applyImport, tickerCandidates } from './importer.js';
import { searchIsins, bestListing } from './providers/yahoo-proxy.js';
import { loadSettings } from './prices.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FIELD_LABEL = { isin: 'ISIN', name: 'Nom', quantity: 'Quantité', unit_cost: 'PRU', last_price: 'Cours', currency: 'Devise', ticker: 'Ticker' };
const SEP_LABEL = { ';': 'point-virgule', ',': 'virgule', '\t': 'tabulation' };

/**
 * Wire the dialog. getState() -> { portfolio, config }; onApply(nextPortfolio, summary) persists it.
 */
export function initImport({ dialog, openButton, getState, onApply }) {
  let current = null; // { diff, profile, file, priceAsOf }
  let seq = 0; // ignore a ticker search that finishes after the file / envelope changed

  function shell() {
    const { config } = getState();
    const profiles = Object.entries(config.imports ?? {});
    const quoteEnvs = config.envelopes;
    const def = profiles[0]?.[1]?.envelope_default;
    dialog.innerHTML = `
      <form method="dialog" class="import-form">
        <h2 id="import-title">Importer des positions (CSV)</h2>
        <p class="sub-title">Le fichier est lu dans ce navigateur, rien n'est envoyé. Aucun changement avant « Appliquer ».</p>
        <div class="import-pickers">
          <label class="field"><span>Format</span><select name="profile">${profiles.map(([id, p]) => `<option value="${esc(id)}">${esc(p.label)}</option>`).join('')}</select></label>
          <label class="field"><span>Enveloppe concernée</span><select name="envelope">${quoteEnvs.map((e) => `<option value="${esc(e.id)}"${e.id === def ? ' selected' : ''}>${esc(e.label)} — ${esc(e.institution ?? '')}</option>`).join('')}</select></label>
          <label class="field"><span>Fichier CSV</span><input type="file" name="file" accept=".csv,text/csv,text/plain"></label>
        </div>
        <div class="import-result" aria-live="polite"></div>
        <div class="dialog-actions">
          <button type="button" data-close>Fermer</button>
          <button type="button" class="primary" data-apply disabled>Appliquer</button>
        </div>
      </form>`;
    const form = dialog.querySelector('form');
    form.addEventListener('change', (e) => { if (['file', 'profile', 'envelope'].includes(e.target.name)) analyse(form); });
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-apply]').addEventListener('click', () => apply(form));
  }

  async function analyse(form) {
    const out = dialog.querySelector('.import-result');
    const applyBtn = dialog.querySelector('[data-apply]');
    applyBtn.disabled = true;
    current = null;
    const file = form.file.files[0];
    if (!file) { out.innerHTML = ''; return; }
    const { portfolio, config } = getState();
    const profile = config.imports[form.profile.value];
    const envelope = form.envelope.value;
    const { text, encoding } = decode(new Uint8Array(await file.arrayBuffer()));
    const read = readPositions(text, profile);
    const mapping = Object.keys(profile.columns).map((f) => `<tr><td>${FIELD_LABEL[f] ?? f}</td><td>${read.map[f] ? `<code>${esc(read.map[f])}</code>` : '<span class="sub">absente</span>'}</td></tr>`).join('');
    const head = `<p class="import-meta">${esc(file.name)} · ${encoding} · séparateur ${SEP_LABEL[read.separator] ?? read.separator} · ${read.positions.length} position(s) lue(s)</p>
      <details${read.missing.length ? ' open' : ''}><summary>Colonnes reconnues</summary><table class="mini">${mapping}</table></details>`;
    if (read.missing.length || (!read.map.isin && !read.map.name)) {
      const need = read.missing.length ? read.missing.map((f) => FIELD_LABEL[f] ?? f).join(', ') : 'ISIN ou Nom';
      out.innerHTML = `${head}<div class="errors"><p><strong>Colonne(s) introuvable(s) : ${esc(need)}.</strong></p>
        <p>En-têtes trouvés : ${read.headers.map((h) => `<code>${esc(h)}</code>`).join(' ')}</p>
        <p>Ajoutez le bon nom à <code>config.json → imports.${esc(form.profile.value)}.columns</code>.</p></div>`;
      return;
    }
    const diff = diffPositions(read.positions, portfolio, config, envelope, profile);
    const priceAsOf = dateFromFileName(file.name) ?? new Date(file.lastModified).toISOString().replace(/\.\d{3}Z$/, 'Z');
    current = { diff, profile, file, priceAsOf, envelope };
    const cur = (h) => h.currency ?? config.base_currency;
    const val = (f, v, h) => (v === undefined || v === null ? '—' : f === 'unit_cost' ? fmt.money(v, cur(h)) : fmt.number(v, 6));
    // Guard: more lines missing than matched usually means the wrong envelope or a partial export.
    const matched = diff.changed.length + diff.unchanged;
    const suspicious = diff.removed.length > 0 && diff.removed.length >= matched;
    const box = (kind, id, label) => `<input type="checkbox" data-pick="${kind}" value="${esc(id)}"${kind === 'removed' && suspicious ? '' : ' checked'} aria-label="${esc(label)}">`;
    out.innerHTML = `${head}
      ${read.problems.length ? `<div class="import-problems"><p>⚠ ${read.problems.length} point(s) à vérifier :</p><ul>${read.problems.slice(0, 20).map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
      <p class="import-summary">${diff.added.length} ajout(s) · ${diff.changed.length} modification(s) · ${diff.removed.length} suppression(s) · ${diff.unchanged} inchangée(s)</p>
      ${diff.added.length ? `<h3>Ajouts</h3><table class="mini diff"><tbody>${diff.added.map((a) => `<tr class="d-add"><td>${box('added', a.holding.id, `Ajouter ${a.holding.name}`)}</td>
        <td><strong>${esc(a.holding.name)}</strong><span class="sub">${esc(a.holding.isin ?? '')} · ${a.holding.asset_class === 'etf' ? 'ETF (deviné d\'après le nom)' : 'Action'} · ticker : voir plus bas</span></td>
        <td class="num">${val('quantity', a.holding.quantity)} × ${val('unit_cost', a.holding.unit_cost, a.holding)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${diff.changed.length ? `<h3>Modifications</h3><table class="mini diff"><tbody>${diff.changed.map((c) => `<tr class="d-chg"><td>${box('changed', c.holding.id, `Modifier ${c.holding.name}`)}</td>
        <td><strong>${esc(c.holding.name)}</strong></td>
        <td>${c.fields.map((f) => `${FIELD_LABEL[f.field]} : <del>${val(f.field, f.old, c.holding)}</del> → <ins>${val(f.field, f.new, c.holding)}</ins>`).join('<br>')}</td></tr>`).join('')}</tbody></table>` : ''}
      ${diff.removed.length ? `<h3>Absentes du fichier</h3>${suspicious
        ? `<div class="import-problems"><p>⚠ ${diff.removed.length} ligne(s) absente(s) pour ${matched} reconnue(s) : mauvaise enveloppe ou export partiel ? Les suppressions sont décochées par sécurité.</p></div>`
        : '<p class="sub">Lignes de cette enveloppe qui ne sont plus dans l’export (vendues ?). Décochez pour les garder.</p>'}
        <table class="mini diff"><tbody>${diff.removed.map((r) => `<tr class="d-del"><td>${box('removed', r.holding.id, `Supprimer ${r.holding.name}`)}</td>
        <td><strong>${esc(r.holding.name)}</strong><span class="sub">${esc(r.holding.isin ?? '')}</span></td><td class="num">${val('quantity', r.holding.quantity)} titres</td></tr>`).join('')}</tbody></table>` : ''}
      ${!diff.added.length && !diff.changed.length && !diff.removed.length ? '<p>Tout est déjà à jour.</p>' : ''}
      <div class="import-tickers"></div>`;
    const refreshCount = () => {
      const n = dialog.querySelectorAll('[data-pick]:checked, [data-ticker]:checked').length;
      applyBtn.disabled = n === 0;
      applyBtn.textContent = n ? `Appliquer ${n} changement${n > 1 ? 's' : ''}` : 'Appliquer';
    };
    out.querySelectorAll('[data-pick]').forEach((c) => c.addEventListener('change', refreshCount));
    refreshCount();
    lookupTickers(out.querySelector('.import-tickers'), tickerCandidates(diff, portfolio, config, envelope), config, refreshCount);
  }

  /** ISIN -> suggested ticker for each candidate line; failures only show a note (the import still works). */
  async function lookupTickers(box, cands, config, refreshCount) {
    const token = ++seq;
    if (!cands.length) return;
    const settings = loadSettings();
    if (!settings.yahoo_proxy_url) {
      box.innerHTML = `<p class="sub">${cands.length} ligne(s) sans ticker : renseignez l’URL du proxy (Réglages) pour les compléter automatiquement.</p>`;
      return;
    }
    box.innerHTML = `<h3>Tickers</h3><p><span class="spinner" aria-hidden="true"></span> Recherche des tickers par ISIN…</p>`;
    let found;
    try {
      found = await searchIsins([...new Set(cands.map((c) => c.isin))], { settings, base: config.base_currency });
    } catch (e) {
      if (token === seq) box.innerHTML = `<div class="import-problems"><p>Tickers non recherchés : ${esc(e.message)}. Utilisez « Compléter » après l’import.</p></div>`;
      return;
    }
    if (token !== seq) return;
    const pref = config.providers?.preferred_exchanges ?? [];
    box.innerHTML = `<h3>Tickers</h3><p class="sub">Trouvés d’après l’ISIN (Yahoo, via votre proxy). Vérifiez la place de cotation ; ils servent aux cours en direct et aux ratios (PER).</p>
      <table class="mini diff"><tbody>${cands.map((c) => {
        const { pick, candidates } = bestListing(found.results[c.isin] ?? [], pref);
        return `<tr><td><input type="checkbox" data-ticker="${esc(c.id)}"${pick ? ' checked' : ' disabled'} aria-label="Ticker pour ${esc(c.name)}"></td>
          <td><strong>${esc(c.name)}</strong><span class="sub">${esc(c.isin)}${c.isNew ? ' · nouvelle ligne' : ''}</span></td>
          <td>${pick ? `<select data-ticker-sym="${esc(c.id)}" aria-label="Cotation pour ${esc(c.name)}">${candidates.map((x) => `<option value="${esc(x.symbol)}">${esc(x.symbol)} — ${esc(x.exchange_name)} (${esc(x.type)})</option>`).join('')}</select>`
            : `<span class="sub">${esc(found.errors[c.isin] ?? 'introuvable')}</span>`}</td></tr>`;
      }).join('')}</tbody></table>`;
    box.querySelectorAll('[data-ticker]').forEach((c) => c.addEventListener('change', refreshCount));
    refreshCount();
  }

  function apply() {
    if (!current) return;
    const picked = { added: new Set(), changed: new Set(), removed: new Set() };
    dialog.querySelectorAll('[data-pick]:checked').forEach((c) => picked[c.dataset.pick].add(c.value));
    const tickers = {};
    dialog.querySelectorAll('[data-ticker]:checked').forEach((c) => {
      const sym = dialog.querySelector(`[data-ticker-sym="${CSS.escape(c.dataset.ticker)}"]`)?.value;
      if (sym) tickers[c.dataset.ticker] = sym;
    });
    const { portfolio } = getState();
    const label = `import ${current.profile.label} (${current.file.name})`;
    const next = applyImport(portfolio, current.diff, picked, { label, price: { as_of: current.priceAsOf, source: current.profile.label }, tickers });
    const ok = onApply(next, { added: picked.added.size, changed: picked.changed.size, removed: picked.removed.size, tickers: Object.keys(tickers).length });
    if (ok) dialog.close();
  }

  openButton.addEventListener('click', () => { shell(); dialog.showModal(); });
}
