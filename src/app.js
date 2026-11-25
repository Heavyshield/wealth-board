// Bootstrap: load data, validate, value, render. No data or rules hardcoded here.

import * as data from './data.js';
import * as fmt from './format.js';
import { valueHoldings, totals } from './valuation.js';
import { HoldingsTable, STATUS_LABEL } from './table.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const app = { files: null, source: null, schemas: null, table: null };

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

function showErrors(byFile) {
  const box = $('#errors');
  const files = Object.entries(byFile);
  box.hidden = files.length === 0;
  box.innerHTML = files.map(([file, errs]) => `
    <h2>Erreurs dans data/${file}.json</h2>
    <ul>${errs.slice(0, 30).map((e) => `<li><code>${esc(e.path)}</code> : ${esc(e.message)}</li>`).join('')}</ul>
    ${errs.length > 30 ? `<p>… et ${errs.length - 30} autres.</p>` : ''}`).join('');
}

function showConflicts(conflicts) {
  const box = $('#conflicts');
  box.hidden = conflicts.length === 0;
  box.innerHTML = conflicts.map((c) => `
    <div class="conflict" data-file="${c.file}">
      <p><strong>data/${c.file}.json a changé</strong> (révision ${c.theirs.revision}, ${fmt.date(c.theirs.updated_at)})
      depuis votre dernière copie locale (rév. ${c.mine.revision}).
      Rien n'a été écrasé. Que garder ?</p>
      <button type="button" data-keep="mine">Garder ma copie</button>
      <button type="button" data-keep="theirs">Prendre le fichier</button>
      <button type="button" data-keep="export">Télécharger ma copie d'abord</button>
    </div>`).join('');
  box.querySelectorAll('[data-keep]').forEach((b) => b.addEventListener('click', () => {
    const file = b.closest('[data-file]').dataset.file;
    const c = conflicts.find((x) => x.file === file);
    if (b.dataset.keep === 'export') return data.downloadJson(`${file}.mine`, c.mine);
    if (b.dataset.keep === 'mine') data.saveWorking(file, c.mine, c.theirs.revision);
    if (b.dataset.keep === 'theirs') { data.dropWorking(file); app.files[file] = c.theirs; }
    conflicts.splice(conflicts.indexOf(c), 1);
    showConflicts(conflicts);
    render();
  }));
}

function renderSummary(rows, config, now) {
  const t = totals(rows);
  const base = config.base_currency;
  const share = t.by_status_share;
  const strip = Object.entries(STATUS_LABEL)
    .filter(([k]) => share[k])
    .map(([k, label]) => `<span class="seg seg-${k}" style="flex:${share[k]}" title="${label} : ${fmt.pct(share[k], { signed: false })}"></span>`).join('');
  const legend = Object.entries(STATUS_LABEL)
    .filter(([k]) => share[k])
    .map(([k, label]) => `<li><span class="dot seg-${k}"></span>${label} ${fmt.pct(share[k], { signed: false })}</li>`).join('');
  $('#summary').innerHTML = `
    <div class="kpi">
      <span class="kpi-label">Patrimoine total</span>
      <span class="kpi-value">${fmt.money(t.value, base)}</span>
      <span class="kpi-sub ${t.pnl >= 0 ? 'pos' : 'neg'}">${fmt.signedMoney(t.pnl, base)} (${fmt.pct(t.cost ? t.pnl / t.cost : null)}) vs prix de revient</span>
    </div>
    <div class="freshness" aria-label="Fraîcheur des prix, en part de la valeur">
      <span class="kpi-label">Fraîcheur des prix (part de la valeur)</span>
      <div class="strip">${strip}</div>
      <ul class="legend">${legend}</ul>
      ${t.missing_fx ? `<p class="warn">${t.missing_fx} ligne(s) exclue(s) : taux de change manquant.</p>` : ''}
    </div>`;
}

function render() {
  const { portfolio, config } = app.files;
  const now = new Date();
  const rows = valueHoldings({ portfolio, config, now });
  $('#sample-banner').hidden = !portfolio.sample_data;
  $('#rev').textContent = `portfolio rév. ${portfolio.revision}${data.hasWorking('portfolio') ? ' · copie locale' : ''}`;
  renderSummary(rows, config, now);
  app.table.setData(rows, config, now);
}

function onEdits(kind, edits) {
  if (kind !== 'save') return;
  const next = data.applyEdits(app.files.portfolio, edits, 'user');
  const errs = data.validateAll({ ...app.files, portfolio: next }, app.schemas);
  if (errs.portfolio) { showErrors(errs); toast('Modification refusée : données invalides.', 'error'); return; }
  data.saveWorking('portfolio', next, app.source.portfolio.revision);
  app.files.portfolio = next;
  app.table.clearEdits();
  render();
  toast(`Enregistré dans la copie locale (rév. ${next.revision}). Exportez pour mettre à jour le fichier.`);
}

function initTheme() {
  const saved = localStorage.getItem('wb.ui.theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme
      ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('wb.ui.theme', next);
  });
}

async function main() {
  initTheme();
  if (location.protocol === 'file:') {
    showErrors({ page: [{ path: 'index.html', message: "ouvert en file:// : les navigateurs bloquent le chargement des JSON. Utilisez l'adresse GitHub Pages ou « python -m http.server » dans le dossier." }] });
    return;
  }
  try {
    const [schemas, loaded] = await Promise.all([data.loadSchemas(), data.loadAll()]);
    Object.assign(app, { schemas, files: loaded.files, source: loaded.source });
    fmt.setLocale(loaded.files.config.locale);
    const errs = data.validateAll(app.files, schemas);
    showErrors(errs);
    if (errs.portfolio || errs.config) return; // cannot value safely
    showConflicts(loaded.conflicts);
    app.table = new HoldingsTable($('#holdings'), { onEditsChange: onEdits });
    render();
  } catch (e) {
    showErrors({ chargement: [{ path: 'data', message: e.message }] });
    console.error(e);
  }

  $('#export').addEventListener('click', () => data.downloadJson('portfolio', app.files.portfolio));
  $('#reset-local').addEventListener('click', () => {
    if (!confirm('Supprimer la copie locale et recharger les fichiers ? Les modifications non exportées seront perdues.')) return;
    data.FILES.forEach(data.dropWorking);
    location.reload();
  });
}

main();
