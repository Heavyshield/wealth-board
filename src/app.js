// Bootstrap: load data, validate, value, render. No data or rules hardcoded here.

import * as data from './data.js';
import * as fmt from './format.js';
import { valueHoldings } from './valuation.js';
import { HoldingsTable } from './table.js';
import * as viz from './charts.js';
import { evaluateRules, evaluateConstraints, reviewItems } from './rules.js';
import { renderReview, renderConstraints } from './review.js';
import * as prices from './prices.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const app = { files: null, source: null, schemas: null, table: null, rows: null, grouping: localStorage.getItem('wb.ui.grouping') || 'envelope',
  live: { fx: {}, spot: {}, quotes: {} }, report: null, refreshed_at: null, refreshing: false, merged: null };

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
  const merged = prices.mergeLive(portfolio, config, app.live);
  app.merged = merged;
  const rows = evaluateRules(valueHoldings({ portfolio: merged.portfolio, config, now, quotes: merged.quotes }), config, now);
  app.rows = rows;
  const constraints = evaluateConstraints(rows, portfolio, config);
  renderReview($('#review'), reviewItems(rows, constraints, config, fmt), { onSelect: focusTarget });
  renderConstraints($('#constraints'), constraints);
  $('#sample-banner').hidden = !portfolio.sample_data;
  $('#rev').textContent = `portfolio rév. ${portfolio.revision}${data.hasWorking('portfolio') ? ' · copie locale' : ''}`;
  viz.renderKpis($('#summary'), rows, config, app.files.history);
  renderCharts();
  app.table.setData(rows, config, now);
  if (!app.refreshing) renderPriceStatus();
}

// ---------------------------------------------------------------- prices
function renderPriceStatus(progress) {
  const el = $('#price-status');
  const rep = app.report;
  const live = Object.keys(app.merged?.quotes ?? {}).length;
  const errs = (rep ?? []).flatMap((r) => Object.entries(r.errors).map(([k, m]) => ({ p: prices.PROVIDERS[r.provider]?.label ?? r.provider, k, m })));
  const lines = (rep ?? []).map((r) => {
    const label = prices.PROVIDERS[r.provider]?.label ?? r.provider;
    const kind = { fx: 'change', spot: 'métaux', quote: 'cours' }[r.kind];
    const nErr = Object.keys(r.errors).length;
    return r.skipped ? `<li>${esc(label)} (${kind}) : ${esc(r.skipped)}</li>` : `<li>${esc(label)} (${kind}) : ${r.ok} OK${nErr ? `, ${nErr} échec(s)` : ''}</li>`;
  }).join('');
  const time = app.refreshed_at ? new Date(app.refreshed_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
  const main = progress ? `<span class="spinner" aria-hidden="true"></span> ${esc(progress)}`
    : app.refreshed_at ? `Cours vérifiés à ${time} · change, métaux et ${live} cours d'action en direct`
    : 'Cours du fichier (pas encore actualisés dans ce navigateur)';
  el.innerHTML = `<span class="ps-main">${main}</span>
    ${rep ? `<details class="ps-details"><summary>${errs.length ? `⚠ ${errs.length} problème(s)` : 'Détails'}</summary>
      <ul>${lines}</ul>
      ${errs.length ? `<ul class="ps-errors">${errs.slice(0, 30).map((e) => `<li><code>${esc(e.k)}</code> (${esc(e.p)}) : ${esc(e.m)}</li>`).join('')}</ul>` : ''}
    </details>` : ''}
    ${live || Object.keys(app.live.fx).length || Object.keys(app.live.spot).length ? '<button type="button" id="persist-prices" title="Écrire ces cours dans portfolio.json (copie locale) pour Claude et les autres appareils">Mémoriser les cours</button>' : ''}`;
  $('#persist-prices')?.addEventListener('click', persistPrices);
}

async function refreshPrices(force) {
  if (app.refreshing) return;
  app.refreshing = true;
  $('#refresh').disabled = true;
  try {
    const res = await prices.refreshPrices(app.files.portfolio, app.files.config, { force, onProgress: (m) => renderPriceStatus(m) });
    Object.assign(app, { live: res.live, report: res.report, refreshed_at: res.refreshed_at });
  } catch (e) {
    toast(`Actualisation impossible : ${e.message}`, 'error');
    console.error(e);
  } finally {
    app.refreshing = false;
    $('#refresh').disabled = false;
    render();
  }
}

function persistPrices() {
  const next = prices.persistPrices(app.files.portfolio, app.merged, 'user');
  const errs = data.validateAll({ ...app.files, portfolio: next }, app.schemas);
  if (errs.portfolio) { toast(`Refusé : ${errs.portfolio[0].path} : ${errs.portfolio[0].message}`, 'error'); return; }
  data.saveWorking('portfolio', next, app.source.portfolio.revision);
  app.files.portfolio = next;
  render();
  toast(`Cours mémorisés dans la copie locale (rév. ${next.revision}).`);
}

function initSettings() {
  const dlg = $('#settings'), form = $('#settings-form');
  $('#open-settings').addEventListener('click', () => {
    const s = prices.loadSettings();
    form.yahoo_proxy_url.value = s.yahoo_proxy_url ?? '';
    form.twelvedata_key.value = s.twelvedata_key ?? '';
    dlg.showModal();
  });
  $('#settings-cancel').addEventListener('click', () => dlg.close());
  $('#clear-cache').addEventListener('click', () => {
    prices.clearCache();
    Object.assign(app, { live: { fx: {}, spot: {}, quotes: {} }, report: null, refreshed_at: null });
    render();
    toast('Cache des cours vidé.');
  });
  form.addEventListener('submit', () => {
    const url = form.yahoo_proxy_url.value.trim();
    prices.saveSettings({ yahoo_proxy_url: url || undefined, twelvedata_key: form.twelvedata_key.value.trim() || undefined });
    toast('Réglages enregistrés dans ce navigateur.');
    refreshPrices(true);
  });
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
    app.live = prices.liveFromCache(app.files.portfolio, app.files.config);
    const unknown = Object.entries(app.files.config.providers ?? {})
      .filter(([k]) => ['fx', 'spot', 'quote'].includes(k))
      .flatMap(([k, ids]) => ids.filter((id) => prices.PROVIDERS[id]?.kind !== k).map((id) => ({
        path: `config.providers.${k}`,
        message: `fournisseur « ${id} » inconnu pour ce type (disponibles : ${Object.values(prices.PROVIDERS).filter((p) => p.kind === k).map((p) => p.id).join(', ')})`,
      })));
    if (unknown.length) showErrors({ config: unknown });
    initSettings();
    $('#refresh').addEventListener('click', () => refreshPrices(true));
    render();
    if (app.files.config.providers?.auto_refresh) refreshPrices(false);
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
