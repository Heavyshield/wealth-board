// Holdings table: sort, search, filters, column picker, inline edit (quantity, unit_cost, notes).
// Column *definitions* live here (presentation); which columns show is config.table.default_columns,
// overridden per device by the column picker (localStorage "wb.ui.columns").

import * as fmt from './format.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const STATUS_LABEL = {
  live: 'à jour', stale: 'périmé', manual: 'manuel', balance: 'solde', missing: 'absent',
};
const STATUS_HELP = {
  live: 'Prix de marché récent',
  stale: 'Prix de marché trop ancien : à rafraîchir',
  manual: 'Prix saisi à la main (prioritaire)',
  balance: 'Solde saisi : valeur = quantité',
  missing: 'Aucun prix : valorisé au prix de revient',
};

export function statusBadge(price, now) {
  const when = price.as_of ? `${fmt.date(price.as_of)} (${fmt.age(price.as_of, now)})` : 'jamais';
  const title = `${STATUS_HELP[price.status]} · source : ${price.source} · mis à jour : ${when}`;
  return `<span class="badge badge-${price.status}" title="${esc(title)}">${STATUS_LABEL[price.status]}</span>`;
}

function columns(ctx) {
  const { base, envLabel, classLabel, now } = ctx;
  const signCls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  return [
    { id: 'name', label: 'Ligne', sort: (r) => r.h.name.toLowerCase(), always: true,
      cell: (r) => `<span class="name">${esc(r.h.name)}</span><span class="sub">${esc([r.h.ticker, r.h.isin].filter(Boolean).join(' · '))}</span>` },
    { id: 'envelope', label: 'Enveloppe', sort: (r) => envLabel(r.h.envelope), cell: (r) => esc(envLabel(r.h.envelope)) },
    { id: 'asset_class', label: 'Classe', sort: (r) => classLabel(r.h.asset_class), cell: (r) => esc(classLabel(r.h.asset_class)) },
    { id: 'currency', label: 'Devise', sort: (r) => r.h.currency, cell: (r) => esc(r.h.currency) },
    { id: 'region', label: 'Région', sort: (r) => r.region, cell: (r) => esc(r.region) },
    { id: 'tags', label: 'Tags', sort: (r) => r.h.tags.join(','), cell: (r) => r.h.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') },
    { id: 'quantity', label: 'Quantité', num: true, edit: 'number', sort: (r) => r.h.quantity,
      cell: (r) => (r.h.metal ? `${fmt.number(r.h.quantity)}<span class="sub">${fmt.number(r.h.metal.weight)} ${r.h.metal.unit} · ${fmt.number(r.h.metal.purity * 1000, 1)}‰</span>` : fmt.number(r.h.quantity)) },
    { id: 'unit_cost', label: 'PRU', num: true, edit: 'number', sort: (r) => r.h.unit_cost,
      cell: (r) => (r.pricing === 'par' ? '—' : fmt.money(r.h.unit_cost, r.h.currency)) },
    { id: 'price', label: 'Cours', num: true, sort: (r) => r.price.value,
      cell: (r) => `${r.price.status === 'balance' ? '' : fmt.money(r.price.value, r.price.currency)} ${statusBadge(r.price, now)}<span class="sub">${r.price.as_of ? fmt.age(r.price.as_of, now) : 'pas de prix'}</span>` },
    { id: 'value_base', label: `Valeur (${base})`, num: true, sort: (r) => r.value_base ?? -Infinity,
      cell: (r) => (r.fx_missing ? '<span class="badge badge-missing" title="Taux de change manquant">FX ?</span>' : fmt.money(r.value_base, base)) },
    { id: 'pnl_base', label: '+/- value', num: true, sort: (r) => r.pnl_base ?? -Infinity,
      cell: (r) => `<span class="${signCls(r.pnl_base)}">${fmt.signedMoney(r.pnl_base, base)}</span>` },
    { id: 'pnl_pct', label: '+/- %', num: true, sort: (r) => r.pnl_pct ?? -Infinity,
      cell: (r) => `<span class="${signCls(r.pnl_pct)}">${fmt.pct(r.pnl_pct)}</span>` },
    { id: 'pnl_fx', label: 'dont change', num: true, sort: (r) => r.pnl_fx_base ?? -Infinity,
      cell: (r) => (r.h.currency === base ? '—' : `<span class="${signCls(r.pnl_fx_base)}">${fmt.signedMoney(r.pnl_fx_base, base)}</span>${r.cost_fx_known ? '' : '<span class="sub" title="Ajouter cost_fx_rate pour isoler l\'effet de change">taux d\'achat inconnu</span>'}`) },
    { id: 'notes', label: 'Notes', edit: 'text', sort: (r) => r.h.notes, cell: (r) => esc(r.h.notes) },
    { id: 'updated_at', label: 'Modifié', sort: (r) => r.h.updated_at, cell: (r) => fmt.date(r.h.updated_at) },
  ];
}

export class HoldingsTable {
  constructor(root, { onEditsChange }) {
    this.root = root;
    this.onEditsChange = onEditsChange;
    this.state = { sort: { key: 'value_base', dir: -1 }, search: '', filters: {}, editMode: false };
    this.edits = {}; // { holdingId: { field: value } }
  }

  setData(rows, config, now) {
    this.rows = rows;
    this.config = config;
    this.now = now;
    const env = Object.fromEntries(config.envelopes.map((e) => [e.id, e.label]));
    const cls = Object.fromEntries(config.asset_classes.map((c) => [c.id, c.label]));
    this.cols = columns({ base: config.base_currency, envLabel: (id) => env[id] ?? id, classLabel: (id) => cls[id] ?? id, now });
    this.labels = { env, cls };
    const saved = JSON.parse(localStorage.getItem('wb.ui.columns') || 'null');
    this.visible = new Set(saved ?? config.table?.default_columns ?? this.cols.map((c) => c.id));
    this.render();
  }

  filtered() {
    const { search, filters } = this.state;
    const q = search.trim().toLowerCase();
    return this.rows.filter((r) => {
      const h = r.h;
      if (filters.envelope && h.envelope !== filters.envelope) return false;
      if (filters.asset_class && h.asset_class !== filters.asset_class) return false;
      if (filters.currency && h.currency !== filters.currency) return false;
      if (filters.tag && !h.tags.includes(filters.tag)) return false;
      if (filters.status && r.price.status !== filters.status) return false;
      if (q && ![h.name, h.ticker, h.isin, h.notes, ...h.tags].some((s) => s?.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  sorted(rows) {
    const col = this.cols.find((c) => c.id === this.state.sort.key);
    if (!col) return rows;
    const dir = this.state.sort.dir;
    return [...rows].sort((a, b) => {
      const x = col.sort(a), y = col.sort(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }

  filterControls() {
    const opt = (pairs, current) => pairs.map(([v, l]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(l)}</option>`).join('');
    const f = this.state.filters;
    const uniq = (xs) => [...new Set(xs)].sort();
    const select = (key, label, pairs) => `<label class="filter"><span>${label}</span><select data-filter="${key}"><option value="">Tous</option>${opt(pairs, f[key])}</select></label>`;
    return [
      `<label class="filter search"><span>Recherche</span><input type="search" data-search placeholder="Nom, ticker, ISIN, note…" value="${esc(this.state.search)}"></label>`,
      select('envelope', 'Enveloppe', this.config.envelopes.map((e) => [e.id, e.label])),
      select('asset_class', 'Classe', this.config.asset_classes.map((c) => [c.id, c.label])),
      select('currency', 'Devise', uniq(this.rows.map((r) => r.h.currency)).map((c) => [c, c])),
      select('tag', 'Tag', uniq(this.rows.flatMap((r) => r.h.tags)).map((t) => [t, t])),
      select('status', 'Prix', Object.entries(STATUS_LABEL)),
    ].join('');
  }

  render() {
    const rows = this.sorted(this.filtered());
    const cols = this.cols.filter((c) => c.always || this.visible.has(c.id));
    const { key, dir } = this.state.sort;
    const pending = Object.values(this.edits).reduce((n, f) => n + Object.keys(f).length, 0);
    const editing = this.state.editMode;

    const head = cols.map((c) => {
      const aria = c.id === key ? (dir > 0 ? 'ascending' : 'descending') : 'none';
      return `<th scope="col" class="${c.num ? 'num' : ''}" aria-sort="${aria}"><button type="button" data-sort="${c.id}">${esc(c.label)}${c.id === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
    }).join('');

    const body = rows.map((r) => {
      const tds = cols.map((c) => {
        const pendingVal = this.edits[r.id]?.[c.id];
        if (editing && c.edit) {
          const val = pendingVal ?? r.h[c.id];
          const input = c.edit === 'number'
            ? `<input type="text" inputmode="decimal" data-edit="${c.id}" data-id="${esc(r.id)}" value="${esc(String(val).replace('.', ','))}" aria-label="${esc(c.label)} ${esc(r.h.name)}">`
            : `<input type="text" data-edit="${c.id}" data-id="${esc(r.id)}" value="${esc(val)}" aria-label="${esc(c.label)} ${esc(r.h.name)}">`;
          return `<td data-label="${esc(c.label)}" class="${c.num ? 'num' : ''}${pendingVal !== undefined ? ' dirty' : ''}">${input}</td>`;
        }
        return `<td data-label="${esc(c.label)}" class="${c.num ? 'num' : ''}">${c.cell(r)}</td>`;
      }).join('');
      return `<tr data-row="${esc(r.id)}">${tds}</tr>`;
    }).join('');

    const picker = this.cols.filter((c) => !c.always).map((c) =>
      `<label><input type="checkbox" data-col="${c.id}"${this.visible.has(c.id) ? ' checked' : ''}> ${esc(c.label)}</label>`).join('');

    this.root.innerHTML = `
      <div class="table-tools">
        <div class="filters">${this.filterControls()}</div>
        <div class="table-actions">
          <details class="col-picker"><summary>Colonnes</summary><div class="col-list">${picker}</div></details>
          <button type="button" data-action="toggle-edit" aria-pressed="${editing}">${editing ? 'Terminer l\'édition' : 'Éditer'}</button>
          ${pending ? `<span class="pending">${pending} modification${pending > 1 ? 's' : ''}</span>
            <button type="button" class="primary" data-action="save">Enregistrer</button>
            <button type="button" data-action="discard">Annuler</button>` : ''}
        </div>
      </div>
      <p class="count">${rows.length} ligne${rows.length > 1 ? 's' : ''} sur ${this.rows.length}</p>
      <div class="table-wrap"><table class="holdings">
        <thead><tr>${head}</tr></thead>
        <tbody>${body || `<tr><td colspan="${cols.length}" class="empty">Aucune ligne ne correspond aux filtres.</td></tr>`}</tbody>
      </table></div>`;
    this.bind();
  }

  bind() {
    const $ = (sel) => this.root.querySelectorAll(sel);
    $('[data-sort]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.sort;
      this.state.sort = { key: k, dir: this.state.sort.key === k ? -this.state.sort.dir : (this.cols.find((c) => c.id === k).num ? -1 : 1) };
      this.render();
    }));
    $('[data-filter]').forEach((s) => s.addEventListener('change', () => { this.state.filters[s.dataset.filter] = s.value || undefined; this.render(); }));
    $('[data-search]').forEach((i) => i.addEventListener('input', () => {
      this.state.search = i.value;
      const pos = i.selectionStart;
      this.render();
      const again = this.root.querySelector('[data-search]');
      again.focus(); again.setSelectionRange(pos, pos);
    }));
    $('[data-col]').forEach((c) => c.addEventListener('change', () => {
      c.checked ? this.visible.add(c.dataset.col) : this.visible.delete(c.dataset.col);
      localStorage.setItem('wb.ui.columns', JSON.stringify([...this.visible]));
      this.render();
      this.root.querySelector('.col-picker').open = true;
    }));
    $('[data-edit]').forEach((i) => i.addEventListener('change', () => this.recordEdit(i)));
    $('[data-action]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.action;
      if (a === 'toggle-edit') { this.state.editMode = !this.state.editMode; this.render(); }
      if (a === 'discard') { this.edits = {}; this.render(); this.onEditsChange?.('discard'); }
      if (a === 'save') this.onEditsChange?.('save', this.edits);
    }));
  }

  recordEdit(input) {
    const { id, edit: field } = input.dataset;
    const h = this.rows.find((r) => r.id === id).h;
    let value = input.value;
    if (field !== 'notes') {
      value = fmt.parseNumber(value);
      if (!Number.isFinite(value) || value < 0) {
        input.setCustomValidity('Nombre positif attendu (ex. 1 234,5)');
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
    }
    this.edits[id] ??= {};
    if (value === h[field]) delete this.edits[id][field];
    else this.edits[id][field] = value;
    if (!Object.keys(this.edits[id]).length) delete this.edits[id];
    // Re-render but keep focus where the user tabbed to.
    const next = document.activeElement?.dataset ?? {};
    this.render();
    if (next.edit) this.root.querySelector(`[data-edit="${next.edit}"][data-id="${CSS.escape(next.id)}"]`)?.focus();
  }

  clearEdits() { this.edits = {}; this.state.editMode = false; this.render(); }
}
