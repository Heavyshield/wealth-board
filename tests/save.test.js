// Save flow rules (src/save-plan.js): one "Enregistrer" = prices + today's snapshot; Drive conflicts on
// real content changes only; the "older file" guard covers every part. Scenarios from the 2026-11-27 review
// (snapshots lost after a false "modified on Drive" warning).

import { prepareSave, remoteChanged, olderParts, copyName } from '../src/save-plan.js';
import { mergeLive } from '../src/prices.js';

export async function saveTests({ test, assert, eq, files, schemas, validate, NOW, rows }) {
  const real = { ...files, portfolio: { ...structuredClone(files.portfolio), sample_data: false }, history: { ...structuredClone(files.history), sample_data: false } };

  await test('Enregistrer : le relevé du jour est ajouté automatiquement (un par jour, remplacé)', () => {
    const merged = mergeLive(real.portfolio, real.config, { fx: {}, spot: {}, quotes: {} });
    const r = prepareSave({ files: real, merged, rows, config: real.config, now: NOW });
    assert(r.changed.includes('history'), 'historique modifié');
    eq(r.files.history.snapshots.filter((s) => s.date === r.snapshot_date).length, 1, 'un relevé ce jour');
    assert(validate(schemas.history, r.files.history).length === 0, 'historique valide');
    const again = prepareSave({ files: r.files, merged, rows, config: real.config, now: new Date(NOW.getTime() + 3600e3) });
    eq(again.files.history.snapshots.length, r.files.history.snapshots.length, 'second enregistrement le même jour : remplacé, pas ajouté');
    const sample = prepareSave({ files, merged, rows, config: files.config, now: NOW });
    assert(!sample.changed.includes('history'), 'données d’exemple : pas de relevé');
  });

  await test('Enregistrer : les cours en direct plus récents sont écrits dans le fichier', () => {
    const live = { fx: {}, spot: {}, quotes: { 'pea-exemple-industries': { value: 99, currency: 'EUR', as_of: '2026-11-24T21:30:00Z', source: 'Yahoo (proxy)' } } };
    const merged = mergeLive(real.portfolio, real.config, live);
    const r = prepareSave({ files: real, merged, rows, config: real.config, now: NOW });
    assert(r.changed.includes('portfolio'), 'positions modifiées');
    eq(r.files.portfolio.holdings.find((h) => h.id === 'pea-exemple-industries').last_price.value, 99, 'cours écrit');
    assert(validate(schemas.portfolio, r.files.portfolio).length === 0, 'portefeuille valide');
  });

  await test('Drive : notre propre enregistrement n’est plus un « conflit » (même contenu, version changée)', () => {
    const meta = { drive_md5: 'abc', drive_version: '10' };
    eq(remoteChanged({ md5Checksum: 'abc', version: '12' }, meta), false, 'Drive a juste incrémenté la version : pas de conflit');
    eq(remoteChanged({ md5Checksum: 'def', version: '12' }, meta), true, 'contenu changé ailleurs : vrai conflit');
    eq(remoteChanged({ version: '10' }, { drive_version: '10' }), false, 'sans empreinte : repli sur la version');
    eq(remoteChanged(null, meta), false, 'pas de fichier : rien à comparer');
  });

  await test('Ouvrir : un fichier plus ancien est signalé pour chaque partie, pas seulement les positions', () => {
    const shown = { portfolio: { revision: 20 }, config: { revision: 5 }, history: { revision: 3 } };
    const opened = { portfolio: { revision: 20 }, config: { revision: 5 }, history: { revision: 1 } };
    eq(olderParts(opened, shown).join(), 'history', 'relevés plus anciens détectés (l’ancienne règle ne regardait que les positions)');
    eq(olderParts({ portfolio: { revision: 21 } }, shown).join(), '', 'plus récent : rien');
  });

  await test('Garder les deux : nom de copie daté', () => {
    assert(/^wealth-board \(copie \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)\.json$/.test(copyName('wealth-board.json', NOW)), copyName('wealth-board.json', NOW));
  });
}
