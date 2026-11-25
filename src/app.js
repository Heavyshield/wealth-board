// Bootstrap: load data, validate, value, render. No data or rules hardcoded here.

import * as data from './data.js';
import * as fmt from './format.js';
import { valueHoldings } from './valuation.js';
import { HoldingsTable } from './table.js';
import * as viz from './charts.js';
import { evaluateRules, evaluateConstraints, reviewItems } from './rules.js';
import { renderReview, renderConstraints } from './review.js';
import { renderPerRank } from './per-rank.js';
import { renderTopMoves } from './top-moves.js';
import * as prices from './prices.js';
import { initImport } from './import-ui.js';
import { createEditors } from './editors.js';
import { initDataUI } from './data-ui.js';
import { makeSnapshot, addSnapshot, buildClaudeExport } from './claude-export.js';
import { renderJournal } from './journal.js';
import { createJsonEditor } from './json-editor.js';
import { metricTargets, fetchMetrics, applyMetrics } from './metrics.js';

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
  app.constraints = constraints;
  app.review = reviewItems(rows, constraints, config, fmt);
  renderReview($('#review'), app.review, { onSelect: focusTarget });
  renderJournal($('#journal'), portfolio);
  renderConstraints($('#constraints'), constraints);
  renderPerRank($('#per-rank'), rows, config, { onSelect: focusTarget });
  renderTopMoves($('#top-moves'), rows, config, { onSelect: focusTarget });
  $('#sample-banner').hidden = !portfolio.sample_data;
  $('#rev').textContent = `rév. ${portfolio.revision}`;
  app.dataUI?.updateBadge();
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
  const quoteIds = new Set(app.files.config.asset_classes.filter((c) => c.pricing === 'quote').map((c) => c.id));
  const noTicker = app.files.portfolio.holdings.filter((h) => quoteIds.has(h.asset_class) && !h.ticker && !h.manual_price && h.price_source !== 'manual').length;
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
    ${noTicker ? `<button type="button" id="fill-tickers">${noTicker} ligne(s) sans ticker · Compléter</button>` : ''}
    ${live || Object.keys(app.live.fx).length || Object.keys(app.live.spot).length ? '<button type="button" id="persist-prices" title="Écrire ces cours dans portfolio.json (copie locale) pour Claude et les autres appareils">Mémoriser les cours</button>' : ''}`;
  $('#persist-prices')?.addEventListener('click', persistPrices);
  $('#fill-tickers')?.addEventListener('click', () => app.editors.openTickers());
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

/** Save a file locally (working copy, marked unsent) and let the sync layer send it. */
function saveLocal(file, next) {
  data.saveWorking(file, next, app.source[file].revision, { dirty: true });
  app.files[file] = next;
  app.dataUI?.afterLocalSave(file);
}

// ---------------------------------------------------------------- stage g: snapshot + export for Claude
function takeSnapshot() {
  const snap = makeSnapshot(app.rows, app.files.config);
  if (app.files.portfolio.sample_data && !confirm('Les données affichées sont des données d\u2019exemple. Enregistrer quand même un relevé ?')) return;
  const exists = app.files.history.snapshots.some((s) => s.date === snap.date);
  if (exists && !confirm(`Un relevé existe déjà pour le ${snap.date}. Le remplacer par les valeurs actuelles ?`)) return;
  const { history } = addSnapshot(app.files.history, snap);
  const errs = data.validateAll({ ...app.files, history }, app.schemas);
  if (errs.history) { toast(`Relevé refusé : ${errs.history[0].path} : ${errs.history[0].message}`, 'error'); return; }
  saveLocal('history', history);
  render();
  toast(`Relevé du ${snap.date} enregistré : ${fmt.money(snap.total, app.files.config.base_currency, { digits: 0 })}. Pensez à enregistrer sur Drive.`);
}

async function exportForClaude() {
  const text = buildClaudeExport({ rows: app.rows, files: app.files, constraints: app.constraints, review: app.review, refreshedAt: app.refreshed_at });
  try {
    await navigator.clipboard.writeText(text);
    toast(`Résumé copié (${Math.round(text.length / 100) / 10} k caractères) : collez-le dans votre conversation avec Claude.`);
  } catch {
    // Clipboard blocked (permissions, http): show it to copy by hand.
    const dlg = $('#export-dialog');
    dlg.innerHTML = `<form method="dialog" class="editor"><h2>Résumé pour Claude</h2><p class="sub-title">Copie automatique impossible : sélectionnez et copiez.</p>
      <textarea readonly rows="16" class="export-text">${esc(text)}</textarea><div class="dialog-actions"><button class="primary">Fermer</button></div></form>`;
    dlg.showModal();
    dlg.querySelector('textarea').select();
  }
}

// ---------------------------------------------------------------- ratios from Yahoo (proxy /metrics)
async function fetchRatios() {
  const targets = metricTargets(app.files.portfolio, app.files.config);
  if (!targets.length) { toast('Aucune ligne avec ticker concernée par les règles (complétez les tickers d’abord).'); return; }
  const todo = targets.filter((t) => !t.manual);
  if (!todo.length) { toast('Toutes les lignes concernées ont des ratios saisis à la main : rien à récupérer.'); return; }
  toast(`Ratios : interrogation de Yahoo pour ${todo.length} ligne(s)…`);
  try {
    const fetched = await fetchMetrics([...new Set(todo.map((t) => t.symbol))], { settings: prices.loadSettings(), base: app.files.config.base_currency });
    const r = applyMetrics(app.files.portfolio, targets, fetched);
    if (!r.updated.length) { toast(`Aucun ratio récupéré. ${r.failed.slice(0, 3).join(' · ')}`, 'error'); return; }
    commitPortfolio(r.portfolio, `Ratios Yahoo : ${r.updated.length} ligne(s)${r.empty.length ? ` dont ${r.empty.length} sans ratio (n/d)` : ''}${r.kept.length ? ` · ${r.kept.length} saisie(s) manuelle(s) gardée(s)` : ''}${r.failed.length ? ` · ${r.failed.length} échec(s)` : ''}`);
  } catch (e) {
    toast(`Ratios indisponibles : ${e.message}`, 'error');
  }
}

/** Validate + save several files at once (Éditeur Données). Returns true on success. */
function commitFiles(next, message) {
  const errs = data.validateAll(next, app.schemas);
  const bad = Object.keys(errs);
  if (bad.length) { toast(`Refusé : ${bad[0]} · ${errs[bad[0]][0].path} : ${errs[bad[0]][0].message}`, 'error'); return false; }
  for (const f of data.FILES) if (next[f] !== app.files[f]) saveLocal(f, next[f]);
  render();
  toast(`${message}. Pensez à enregistrer sur Drive.`);
  refreshPrices(false); // new currencies / tickers / metals: fetch what is missing (cached ones are not refetched)
  return true;
}

/** Validate + save a new portfolio from any editor. Returns true on success. */
function commitPortfolio(next, message) {
  const errs = data.validateAll({ ...app.files, portfolio: next }, app.schemas);
  if (errs.portfolio) { toast(`Refusé : ${errs.portfolio[0].path} : ${errs.portfolio[0].message}`, 'error'); return false; }
  saveLocal('portfolio', next);
  render();
  toast(`${message} (rév. ${next.revision})`);
  refreshPrices(false); // only fetches what the cache does not already have
  return true;
}

function removeSample() {
  const sample = app.source.portfolio;
  const n = app.files.portfolio.holdings.filter((h) => sample.holdings.some((s) => s.id === h.id)).length;
  const msg = `Retirer les ${n} lignes d'exemple et l'historique d'exemple ?\n`
    + 'Vos lignes importées ou ajoutées sont gardées. Le budget, les cibles et les règles (config.json) restent à ajuster.';
  if (!confirm(msg)) return;
  if (!commitPortfolio(data.removeSampleData(app.files.portfolio, sample, 'user'), `${n} lignes d'exemple retirées`)) return;
  if (app.files.history.sample_data) {
    const h = { ...structuredClone(app.files.history), sample_data: false, snapshots: [], revision: app.files.history.revision + 1, updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
    saveLocal('history', h);
    render();
  }
}

function persistPrices() {
  const next = prices.persistPrices(app.files.portfolio, app.merged, 'user');
  const errs = data.validateAll({ ...app.files, portfolio: next }, app.schemas);
  if (errs.portfolio) { toast(`Refusé : ${errs.portfolio[0].path} : ${errs.portfolio[0].message}`, 'error'); return; }
  saveLocal('portfolio', next);
  render();
  toast(`Cours mémorisés dans la copie locale (rév. ${next.revision}).`);
}

function initSettings() {
  const stored = prices.loadSettings();
  if ('twelvedata_key' in stored) { delete stored.twelvedata_key; prices.saveSettings(stored); } // provider removed 2026-11-25
  const dlg = $('#settings'), form = $('#settings-form');
  $('#open-settings').addEventListener('click', () => {
    const s = prices.loadSettings();
    form.yahoo_proxy_url.value = s.yahoo_proxy_url ?? '';
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
    prices.saveSettings({ yahoo_proxy_url: url || undefined });
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
  saveLocal('portfolio', next);
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
    app.table = new HoldingsTable($('#holdings'), { onEditsChange: onEdits, onRowEdit: (id) => app.editors.openLine(id), onAdd: () => app.editors.openLine(null), onFetchRatios: fetchRatios });
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
    $('#snapshot').addEventListener('click', takeSnapshot);
    $('#claude-export').addEventListener('click', exportForClaude);
    app.jsonEditor = createJsonEditor({ dialog: $('#json-editor'), getFiles: () => app.files, schemas: app.schemas, commitFiles });
    app.dataUI = initDataUI({ app, render, toast, dialog: $('#data'), badge: $('#sync-badge'), openButton: $('#open-data'), openEditor: (mode) => app.jsonEditor.open(mode) });
    app.editors = createEditors({ dialog: $('#editor'), getState: () => ({ portfolio: app.files.portfolio, config: app.files.config }), commit: commitPortfolio });
    $('#remove-sample').addEventListener('click', removeSample);
    initImport({
      dialog: $('#import'),
      openButton: $('#open-import'),
      getState: () => ({ portfolio: app.files.portfolio, config: app.files.config }),
      onApply: (next, n) => {
        const errs = data.validateAll({ ...app.files, portfolio: next }, app.schemas);
        if (errs.portfolio) { toast(`Import refusé : ${errs.portfolio[0].path} : ${errs.portfolio[0].message}`, 'error'); return false; }
        saveLocal('portfolio', next);
        render();
        toast(`Import appliqué (rév. ${next.revision}) : ${n.added} ajout(s), ${n.changed} modification(s), ${n.removed} suppression(s)${n.tickers ? `, ${n.tickers} ticker(s)` : ''}. Voir le journal.`);
        if (n.added || n.tickers) refreshPrices(false);
        return true;
      },
    });
    $('#refresh').addEventListener('click', () => refreshPrices(true));
    render();
    if (app.files.config.providers?.auto_refresh) refreshPrices(false);
  } catch (e) {
    showErrors({ chargement: [{ path: 'data', message: e.message }] });
    console.error(e);
  }

}

main();
