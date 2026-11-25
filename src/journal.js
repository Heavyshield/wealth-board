// Changelog view (feature 10): audit what was changed, by you or by Claude. Read-only.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = (v) => {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return Array.isArray(v) ? `${v.length} élément(s)` : esc(v.name ?? v.id ?? JSON.stringify(v).slice(0, 60));
  return esc(v);
};

let filter = 'all';

export function renderJournal(el, portfolio) {
  const all = [...(portfolio.changelog ?? [])].reverse();
  const names = Object.fromEntries(portfolio.holdings.map((h) => [h.id, h.name]));
  const count = (a) => all.filter((c) => c.author === a).length;
  const shown = all.filter((c) => filter === 'all' || c.author === filter).slice(0, 200);
  const open = el.querySelector('details')?.open ?? false;
  el.innerHTML = `<details${open ? ' open' : ''}><summary><h2>Journal des modifications</h2>
      <span class="sub-title">${all.length} entrée(s) · ${count('claude')} par Claude</span></summary>
    <div class="seg-control" role="radiogroup" aria-label="Auteur">
      ${[['all', 'Tous'], ['user', 'Moi'], ['claude', 'Claude']].map(([k, l]) => `<button type="button" role="radio" data-author="${k}" aria-checked="${filter === k}">${l}</button>`).join('')}
    </div>
    ${shown.length ? `<div class="table-wrap"><table class="mini journal"><thead><tr><th scope="col">Date</th><th scope="col">Auteur</th><th scope="col">Ligne</th><th scope="col">Champ</th><th scope="col">Avant → après</th></tr></thead><tbody>
      ${shown.map((c) => `<tr class="${c.author === 'claude' ? 'by-claude' : ''}"><td>${esc(new Date(c.date).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }))}</td>
        <td>${c.author === 'claude' ? '<span class="who-claude">Claude</span>' : 'Moi'}</td>
        <td>${esc(names[c.target] ?? c.target)}</td><td>${esc(c.field)}</td>
        <td>${val(c.old)} → ${val(c.new)}${c.note ? `<span class="sub">${esc(c.note)}</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="sub">Aucune entrée.</p>'}
  </details>`;
  el.querySelectorAll('[data-author]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.author; renderJournal(el, portfolio); el.querySelector('details').open = true; }));
}
