// Editing dialogs that write into the portfolio (always through data.js, so every change is logged):
//   - ticker assistant: ISIN -> Yahoo listing via the proxy, user confirms each line
//   - line editor: add / edit / delete one holding (any class: stocks, accounts, cash, metals)
// All dialogs render into one <dialog>; `commit(nextPortfolio, message)` validates + saves (app.js).

import * as fmt from './format.js';
import * as data from './data.js';
import { makeId } from './importer.js';
import { searchIsins, bestListing, TYPE_TO_CLASS } from './providers/yahoo-proxy.js';
import { loadSettings } from './prices.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const opts = (pairs, cur) => pairs.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');
const today = () => new Date().toISOString().slice(0, 10);
const num = (s) => (String(s).trim() === '' ? undefined : fmt.parseNumber(s));

export function createEditors({ dialog, getState, commit }) {
  const pricingOf = (config, cls) => config.asset_classes.find((c) => c.id === cls)?.pricing ?? 'quote';
  const close = () => dialog.close();
  const show = (html) => { dialog.innerHTML = html; dialog.showModal(); dialog.querySelector('[data-close]')?.addEventListener('click', close); };

  // ------------------------------------------------------------ ticker assistant
  async function openTickers() {
    const { portfolio, config } = getState();
    const lines = portfolio.holdings.filter((h) => pricingOf(config, h.asset_class) === 'quote' && !h.ticker && !h.manual_price && h.price_source !== 'manual');
    show(`<form method="dialog" class="editor"><h2>Compléter les tickers</h2>
      <p class="sub-title">Recherche des cotations Yahoo à partir de l'ISIN (via votre proxy). Vérifiez la place de cotation avant d'appliquer.</p>
      <div class="ed-body">${lines.length ? '<p><span class="spinner" aria-hidden="true"></span> Recherche…</p>' : '<p>Toutes les lignes cotées ont un ticker.</p>'}</div>
      <div class="dialog-actions"><button type="button" data-close>Fermer</button><button type="button" class="primary" data-apply disabled>Appliquer</button></div></form>`);
    if (!lines.length) return;
    const body = dialog.querySelector('.ed-body');
    const isins = [...new Set(lines.filter((h) => h.isin).map((h) => h.isin))];
    let found = { results: {}, errors: {} };
    try {
      if (isins.length) found = await searchIsins(isins, { settings: loadSettings(), base: config.base_currency });
    } catch (e) {
      body.innerHTML = `<div class="errors"><p>${esc(e.message)}</p></div>`;
      return;
    }
    const classes = new Map(config.asset_classes.map((c) => [c.id, c.label]));
    const pref = config.providers?.preferred_exchanges ?? [];
    body.innerHTML = `<table class="mini diff"><tbody>${lines.map((h) => {
      const cands = h.isin ? found.results[h.isin] ?? [] : [];
      const { pick, candidates } = bestListing(cands, pref);
      const sugg = pick ? TYPE_TO_CLASS[pick.type] : null;
      const clsChange = sugg && classes.has(sugg) && sugg !== h.asset_class;
      return `<tr data-id="${esc(h.id)}"><td><input type="checkbox" data-use${pick ? ' checked' : ''} aria-label="Appliquer pour ${esc(h.name)}"></td>
        <td><strong>${esc(h.name)}</strong><span class="sub">${esc(h.isin ?? 'pas d’ISIN')}${!pick ? ` · ${esc(h.isin ? found.errors[h.isin] ?? 'introuvable' : 'saisir le ticker')}` : ''}</span></td>
        <td><select data-sym aria-label="Cotation pour ${esc(h.name)}">${candidates.map((c) => `<option value="${esc(c.symbol)}" data-type="${esc(c.type)}">${esc(c.symbol)} — ${esc(c.exchange_name)} (${esc(c.type)})</option>`).join('')}<option value="">Autre…</option></select>
          <input type="text" data-other placeholder="ex. TTE.PA" aria-label="Ticker saisi pour ${esc(h.name)}" ${candidates.length ? 'hidden' : ''}>
          ${clsChange ? `<label class="sub"><input type="checkbox" data-cls="${esc(sugg)}" checked> classe : ${esc(classes.get(h.asset_class))} → ${esc(classes.get(sugg))}</label>` : ''}</td></tr>`;
    }).join('')}</tbody></table>`;
    const applyBtn = dialog.querySelector('[data-apply]');
    const count = () => { const n = body.querySelectorAll('[data-use]:checked').length; applyBtn.disabled = !n; applyBtn.textContent = n ? `Appliquer (${n})` : 'Appliquer'; };
    body.querySelectorAll('[data-sym]').forEach((sel) => sel.addEventListener('change', () => {
      const row = sel.closest('tr'); row.querySelector('[data-other]').hidden = sel.value !== ''; row.querySelector('[data-use]').checked = true; count();
    }));
    body.querySelectorAll('[data-other]').forEach((i) => i.addEventListener('input', () => { i.closest('tr').querySelector('[data-use]').checked = i.value.trim() !== ''; count(); }));
    body.addEventListener('change', count);
    count();
    applyBtn.addEventListener('click', () => {
      const edits = {};
      body.querySelectorAll('tr[data-id]').forEach((row) => {
        if (!row.querySelector('[data-use]').checked) return;
        const sym = row.querySelector('[data-sym]').value || row.querySelector('[data-other]').value.trim().toUpperCase();
        if (!sym) return;
        edits[row.dataset.id] = { ticker: sym };
        const cls = row.querySelector('[data-cls]');
        if (cls?.checked) edits[row.dataset.id].asset_class = cls.dataset.cls;
      });
      const n = Object.keys(edits).length;
      if (n && commit(data.applyEdits(getState().portfolio, edits, 'user'), `${n} ticker(s) enregistré(s).`)) close();
    });
  }

  // ------------------------------------------------------------ line editor
  function openLine(id) {
    const { portfolio, config } = getState();
    const h = id ? portfolio.holdings.find((x) => x.id === id) : null;
    const v = h ?? { envelope: config.envelopes[0].id, asset_class: config.asset_classes[0].id, currency: config.base_currency, quantity: '', unit_cost: '', tags: [], notes: '' };
    const m = v.metal ?? { code: 'XAU', weight: '', unit: 'g', purity: '' };
    const n = (x) => (x === undefined || x === null || x === '' ? '' : String(x).replace('.', ','));
    show(`<form method="dialog" class="editor" novalidate><h2>${h ? `Modifier « ${esc(h.name)} »` : 'Ajouter une ligne'}</h2>
      <div class="ed-grid">
        <label class="field wide"><span>Nom *</span><input name="name" required value="${esc(v.name)}"></label>
        <label class="field"><span>Enveloppe *</span><select name="envelope">${opts(config.envelopes.map((e) => [e.id, e.label]), v.envelope)}</select></label>
        <label class="field"><span>Classe *</span><select name="asset_class">${opts(config.asset_classes.map((c) => [c.id, c.label]), v.asset_class)}</select></label>
        <label class="field"><span>Devise *</span><input name="currency" maxlength="3" value="${esc(v.currency)}" autocapitalize="characters"></label>
        <label class="field"><span data-qlabel>Quantité *</span><input name="quantity" inputmode="decimal" value="${n(v.quantity)}"${h && h.quantity === null ? ' disabled' : ''}></label>
        <label class="field"><span>Montant connu au (date) *</span><input name="as_of" type="date" value="${esc(v.as_of ?? today())}"></label>
        <label class="field check"><input type="checkbox" name="to_fill"${h && h.quantity === null ? ' checked' : ''}> Montant inconnu (à compléter)</label>
        <label class="field" data-for="cost"><span>Prix de revient unitaire</span><input name="unit_cost" inputmode="decimal" value="${n(v.unit_cost)}"></label>
        <label class="field" data-for="quote"><span>Ticker (format Yahoo)</span><input name="ticker" value="${esc(v.ticker)}" placeholder="TTE.PA"></label>
        <label class="field" data-for="quote"><span>ISIN</span><input name="isin" value="${esc(v.isin)}" autocapitalize="characters"></label>
        <label class="field" data-for="fx"><span>Taux de change à l'achat (1 ${esc(config.base_currency)} = x devise)</span><input name="cost_fx_rate" inputmode="decimal" value="${n(v.cost_fx_rate)}"></label>
        <fieldset class="wide" data-for="spot"><legend>Métal (valorisé au poids fin × cours spot)</legend>
          <label class="field"><span>Métal</span><select name="metal_code">${opts([['XAU', 'Or'], ['XAG', 'Argent'], ['XPT', 'Platine'], ['XPD', 'Palladium']], m.code)}</select></label>
          <label class="field"><span>Poids par pièce</span><input name="metal_weight" inputmode="decimal" value="${n(m.weight)}"></label>
          <label class="field"><span>Unité</span><select name="metal_unit">${opts([['g', 'grammes'], ['oz', 'onces troy'], ['kg', 'kg']], m.unit)}</select></label>
          <label class="field"><span>Pureté (0,9 = 900 ‰)</span><input name="metal_purity" inputmode="decimal" value="${n(m.purity)}"></label>
        </fieldset>
        <fieldset class="wide" data-for="manual"><legend>Prix manuel (optionnel, prioritaire)</legend>
          <label class="field"><span>Prix</span><input name="manual_value" inputmode="decimal" value="${n(v.manual_price?.value)}"></label>
          <label class="field"><span>Date du prix</span><input name="manual_as_of" type="date" value="${esc(v.manual_price?.as_of?.slice(0, 10) ?? '')}"></label>
        </fieldset>
        <label class="field wide"><span>Tags (séparés par des virgules)</span><input name="tags" value="${esc((v.tags ?? []).join(', '))}"></label>
        <label class="field wide"><span>Notes</span><input name="notes" value="${esc(v.notes)}"></label>
      </div>
      <p class="ed-error errors" hidden></p>
      <div class="dialog-actions">${h ? '<button type="button" class="danger" data-delete>Supprimer la ligne</button>' : ''}
        <button type="button" data-close>Annuler</button><button type="submit" class="primary">${h ? 'Enregistrer' : 'Ajouter'}</button></div></form>`);
    const form = dialog.querySelector('form');
    const sync = () => {
      const p = pricingOf(config, form.asset_class.value);
      form.querySelectorAll('[data-for="quote"]').forEach((e) => { e.hidden = p !== 'quote'; });
      form.querySelector('[data-for="spot"]').hidden = p !== 'spot';
      form.querySelector('[data-for="manual"]').hidden = p === 'par';
      form.querySelector('[data-for="cost"]').hidden = p === 'par';
      form.querySelector('[data-for="fx"]').hidden = form.currency.value.toUpperCase() === config.base_currency || p === 'par';
      form.querySelector('[data-qlabel]').textContent = p === 'par' ? 'Solde *' : p === 'spot' ? 'Nombre de pièces / lingots *' : 'Quantité *';
    };
    form.addEventListener('change', sync); form.currency.addEventListener('input', sync); sync();
    form.to_fill.addEventListener('change', () => { form.quantity.disabled = form.to_fill.checked; });
    dialog.querySelector('[data-delete]')?.addEventListener('click', () => {
      if (!confirm(`Supprimer « ${h.name} » ? La ligne complète reste dans le journal des changements.`)) return;
      if (commit(data.removeHolding(getState().portfolio, h.id, 'user'), `Ligne supprimée : ${h.name}.`)) close();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = form.querySelector('.ed-error');
      const fail = (msg) => { err.textContent = msg; err.hidden = false; };
      const f = form.elements;
      const p = pricingOf(config, f.asset_class.value);
      const toFill = f.to_fill.checked;
      const qty = toFill ? null : num(f.quantity.value);
      if (!f.name.value.trim()) return fail('Le nom est obligatoire.');
      if (!/^[A-Z]{3}$/.test(f.currency.value.trim().toUpperCase())) return fail('Devise : 3 lettres (EUR, CHF, USD…).');
      if (!toFill && (!Number.isFinite(qty) || qty < 0)) return fail('Quantité / solde : nombre positif attendu (ou cocher « Montant inconnu »).');
      if (!f.as_of.value) return fail('Date « Montant connu au » obligatoire.');
      const line = {
        name: f.name.value.trim(), envelope: f.envelope.value, asset_class: f.asset_class.value,
        currency: f.currency.value.trim().toUpperCase(), quantity: qty, as_of: f.as_of.value,
        unit_cost: p === 'par' ? 1 : num(f.unit_cost.value) ?? null, // empty = unknown, never 0
        price_source: p === 'par' ? 'par' : p === 'spot' ? 'spot' : (h?.price_source?.startsWith('quote') ? h.price_source : 'quote'),
        tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean), notes: f.notes.value.trim(),
      };
      if (line.unit_cost !== null && (!Number.isFinite(line.unit_cost) || line.unit_cost < 0)) return fail('Prix de revient : nombre positif attendu.');
      const opt = {};
      if (p === 'quote') { opt.ticker = f.ticker.value.trim() || undefined; opt.isin = f.isin.value.trim().toUpperCase() || undefined; }
      const fxr = num(f.cost_fx_rate.value);
      opt.cost_fx_rate = !f.cost_fx_rate.closest('[data-for]').hidden && fxr > 0 ? fxr : undefined;
      if (p === 'spot') {
        const metal = { code: f.metal_code.value, weight: num(f.metal_weight.value), unit: f.metal_unit.value, purity: num(f.metal_purity.value) };
        if (!(metal.weight > 0) || !(metal.purity > 0 && metal.purity <= 1)) return fail('Métal : poids > 0 et pureté entre 0 et 1 (ex. 0,9999).');
        opt.metal = metal;
      } else opt.metal = undefined;
      const mv = num(f.manual_value.value);
      if (p !== 'par' && mv !== undefined) {
        if (!(mv > 0) || !f.manual_as_of.value) return fail('Prix manuel : valeur > 0 et date obligatoires (ou laisser vide).');
        opt.manual_price = { value: mv, as_of: f.manual_as_of.value };
      } else opt.manual_price = undefined;
      const state = getState().portfolio;
      if (!h) {
        const holding = { id: makeId(line.envelope, line.name, new Set(state.holdings.map((x) => x.id))), ...line };
        for (const [k, val] of Object.entries(opt)) if (val !== undefined) holding[k] = val;
        if (commit(data.addHolding(state, holding, 'user'), `Ligne ajoutée : ${line.name}.`)) close();
      } else {
        const edits = { ...line };
        for (const [k, val] of Object.entries(opt)) edits[k] = val ?? null; // null = remove the field
        if (commit(data.applyEdits(state, { [h.id]: edits }, 'user'), `Ligne modifiée : ${line.name}.`)) close();
      }
    });
  }

  return { openTickers, openLine };
}
