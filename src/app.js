// Bootstrap: load data, validate, value, render. No data or rules hardcoded here.

import * as data from './data.js';
import * as fmt from './format.js';
import { valueHoldings } from './valuation.js';
import { HoldingsTable } from './table.js';
import * as viz from './charts.js';
import { evaluateRules, evaluateConstraints, reviewItems } from './rules.js';
import { renderReview, renderConstraints } from './review.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const app = { files: null, source: null, schemas: null, table: null, rows: null, grouping: localStorage.getItem('wb.ui.grouping') || 'envelope' };

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

function renderCharts() {
  const { config, history } = app.files;
  const rows = app.rows;
  $('#charts-off').hidden = viz.chartsAvailable();
  document.querySelectorAll('[data-group]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.group === app.grouping)));
  viz.renderAllocation($('#card-alloc'), rows, config, app.grouping);
  viz.renderHistory($('#card-history'), history, config, rows);
  viz.renderTargets($('#card-targets'), rows, config);
  viz.renderPnl($('#card-pnl'), rows, config);
}

function render() {
  const { portfolio, config } = app.files;
  const now = new Date();
  const rows = evaluateRules(valueHoldings({ portfolio, config, now }), config, now);
  app.rows = rows;
  const constraints = evaluateConstraints(rows, portfolio, config);
  renderReview($('#review'), reviewItems(rows, constraints, config, fmt), { onSelect: focusTarget });
  renderConstraints($('#constraints'), constraints);
  $('#sample-banner').hidden = !portfolio.sample_data;
  $('#rev').textContent = `portfolio rév. ${portfolio.revision}${data.hasWorking('portfolio') ? ' · copie locale' : ''}`;
  viz.renderKpis($('#summary'), rows, config, app.files.history);
  renderCharts();
  app.table.setData(rows, config, now);
}

/** Jump from a review item to what it is about, briefly highlighted. */
function focusTarget(target) {
  let el;
  if (target === 'targets') el = $('#card-targets');
  else if (target.startsWith('constraint:')) el = document.getElementById(`constraint-${target.slice(11)}`);
  else {
    if (!document.getElementById(`row-${target}`)) app.table.resetFilters();
    el = document.getElementById(`row-${target}`);
  }
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

function onEdits(kind, edits) {
  if (kind !== 'save') return;
  const next = data.applyEdits(app.files.portfolio, edits, 'user');
  const errs = data.validateAll({ ...app.files, portfolio: next }, app.schemas);
  if (errs.portfolio) {
    const e = errs.portfolio[0];
    const hint = /metrics.*as_of|« as_of »/.test(`${e.path} ${e.message}`) ? ' Renseignez la date « Métriques au ».' : '';
    toast(`Modification refusée : ${e.path} : ${e.message}.${hint}`, 'error');
    return;
  }
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
    if (app.rows) renderCharts(); // chart colors are read from CSS at draw time
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => app.rows && renderCharts());
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
    viz.configureChartDefaults();
    document.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
      app.grouping = b.dataset.group;
      localStorage.setItem('wb.ui.grouping', app.grouping);
      renderCharts();
    }));
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
