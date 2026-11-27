// Stage e tests: CSV reading (encodings, separators, quotes, numbers) and the import diff.
// Fixtures are FAKE files (tests/fixtures/boursorama-fake-*.csv); expectations are worked out by hand
// from those files and data/portfolio.json (PEA: Exemple Industries 40 x 50, Démo Énergie 100 x 30,
// ETF Monde 25 x 80).

import { decode, parseCsv, parseLooseNumber, dateFromFileName } from '../src/csv.js';
import { readPositions, diffPositions, applyImport, tickerCandidates } from '../src/importer.js';

const bytes = async (name) => new Uint8Array(await (await fetch(`./fixtures/${name}`, { cache: 'no-store' })).arrayBuffer());

export async function importTests({ test, assert, eq, files, schemas, validate, NOW }) {
  const profile = files.config.imports.boursorama;

  await test('Nombres : formats français, anglais, signes, symboles', () => {
    const cases = [['1 234,56', 1234.56], ['1 234,56', 1234.56], ['1.234,56', 1234.56], ['1,234.56', 1234.56],
      ['-3,20 €', -3.2], ['12,5 %', 12.5], ['(45,00)', -45], ['+0,8', 0.8], ['42', 42], ['0,001', 0.001], ['1.000.000', 1000000]];
    for (const [s, n] of cases) eq(parseLooseNumber(s), n, `« ${s} »`);
    assert(Number.isNaN(parseLooseNumber('abc')) && Number.isNaN(parseLooseNumber('')), 'non-nombres');
  });

  await test('CSV : guillemets, séparateur dans un champ, retour ligne dans un champ', () => {
    const r = parseCsv('a;b;c\n"x;y";"multi\nligne";"dit ""oui"""\n');
    eq(r.separator, ';', 'séparateur'); eq(r.rows.length, 1, 'une ligne');
    eq(r.rows[0].a, 'x;y', 'point-virgule protégé'); eq(r.rows[0].b, 'multi\nligne', 'retour ligne'); eq(r.rows[0].c, 'dit "oui"', 'guillemets doublés');
    eq(parseCsv('a,b\n1,2\n').separator, ',', 'virgule détectée');
  });

  await test('Date d’export lue dans le nom de fichier Boursorama', () => {
    const iso = dateFromFileName('export-positions-comptables-25-11-2026_09-30-00.csv');
    const d = new Date(iso);
    eq([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()].join('-'), '2026-11-25-9-30', 'date locale');
    eq(dateFromFileName('positions.csv'), null, 'nom sans date');
  });

  const en = decode(await bytes('boursorama-fake-en.csv'));
  const fr = decode(await bytes('boursorama-fake-fr-cp1252.csv'));

  await test('Encodage : UTF-8 avec BOM et Windows-1252 détectés', () => {
    eq(en.encoding, 'UTF-8', 'UTF-8'); assert(!en.text.startsWith('﻿'), 'BOM retiré');
    eq(fr.encoding, 'Windows-1252', 'cp1252'); assert(fr.text.includes('Démo Énergie'), 'accents corrects');
  });

  await test('Colonnes reconnues par alias (anglais et français, ordre libre)', () => {
    const a = readPositions(en.text, profile);
    eq(JSON.stringify(a.map), JSON.stringify({ isin: 'isin', name: 'name', quantity: 'quantity', unit_cost: 'buyingPrice', last_price: 'lastPrice' }), 'export anglais');
    const b = readPositions(fr.text, profile);
    eq(b.map.unit_cost, 'Prix de revient', 'PRU'); eq(b.map.quantity, 'Quantité', 'quantité'); eq(b.map.name, 'Libellé', 'libellé');
    eq(a.positions.length, 4, '4 positions (ligne de total ignorée)');
    const soc = a.positions.find((p) => p.isin === 'FR0000000009');
    eq(soc.name, 'Nouvelle Société; fictive', 'nom avec ;'); eq(soc.unit_cost, 1050, '« 1 050,00 »');
  });

  await test('Colonne obligatoire absente : erreur lisible, aucune position', () => {
    const r = readPositions(decode(new TextEncoder().encode('name;isin;buyingPrice\r\nX;FR0000000001;10\r\n')).text, profile);
    eq(r.missing.join(), 'quantity', 'quantité manquante'); eq(r.positions.length, 0, 'rien lu');
  });

  const read = readPositions(en.text, profile);
  const diff = diffPositions(read.positions, files.portfolio, files.config, 'pea', profile);

  await test('Diff PEA : 2 ajouts, 1 modification, 1 absente, 1 inchangée', () => {
    eq(diff.added.map((a) => a.holding.id).join(), 'pea-nouvelle-societe-fictive,pea-tracker-msci-exemple-fictif', 'ajouts');
    eq(diff.added[1].holding.asset_class, 'etf', 'tracker deviné ETF');
    eq(diff.changed.length, 1, 'modifications');
    eq(JSON.stringify(diff.changed[0].fields), JSON.stringify([{ field: 'quantity', old: 40, new: 45 }, { field: 'unit_cost', old: 50, new: 51.2 }]), 'champs modifiés');
    eq(diff.removed.map((r) => r.holding.id).join(), 'pea-demo-energie', 'absente');
    eq(diff.unchanged, 1, 'ETF Monde inchangé');
  });

  await test('Diff : autre enveloppe (CTO) jamais touchée, cash et métaux ignorés', () => {
    const d = diffPositions(readPositions(fr.text, profile).positions, files.portfolio, files.config, 'pea', profile);
    eq(d.changed.length + d.added.length, 0, 'fichier FR = déjà à jour'); eq(d.removed.map((r) => r.holding.id).join(), 'pea-etf-monde', 'ETF absent du fichier FR');
    const c = diffPositions(read.positions, files.portfolio, files.config, 'cto', profile);
    assert(c.removed.every((r) => r.holding.envelope === 'cto'), 'seulement le CTO');
  });

  await test('Appliquer une sélection : journal, révision, schéma, prix du fichier', () => {
    const pick = { added: new Set(diff.added.map((a) => a.holding.id)), changed: new Set(['pea-exemple-industries']), removed: new Set() }; // suppression décochée
    const asOf = dateFromFileName('export-positions-comptables-25-11-2026_09-30-00.csv');
    const next = applyImport(files.portfolio, diff, pick, { label: 'import test', now: NOW, price: { as_of: asOf, source: 'Boursorama CSV' } });
    assert(validate(schemas.portfolio, next).length === 0, JSON.stringify(validate(schemas.portfolio, next).slice(0, 3)));
    eq(next.revision, files.portfolio.revision + 1, 'révision');
    assert(next.holdings.some((h) => h.id === 'pea-demo-energie'), 'suppression décochée = ligne gardée');
    const ex = next.holdings.find((h) => h.id === 'pea-exemple-industries');
    eq(ex.quantity, 45, 'quantité'); eq(ex.unit_cost, 51.2, 'PRU');
    eq(next.changelog.find((c) => c.target === 'pea-exemple-industries' && c.field === 'quantity').price, 62.5, 'prix de l’export noté sur l’ordre');
    eq(ex.last_price.value, 62.5, 'prix du fichier, plus récent que le cache'); eq(ex.last_price.source, 'Boursorama CSV', 'source');
    const soc = next.holdings.find((h) => h.id === 'pea-nouvelle-societe-fictive');
    eq(soc.last_price.value, 1080, 'prix de la nouvelle ligne');
    eq(next.changelog.length - files.portfolio.changelog.length, 4, '2 ajouts + 2 champs');
    assert(next.changelog.every((c) => c.author === 'user'), 'auteur');
    const removedAll = applyImport(files.portfolio, diff, { added: new Set(), changed: new Set(), removed: new Set(['pea-demo-energie']) }, { label: 't', now: NOW });
    const log = removedAll.changelog.at(-1);
    eq(log.new, 'suppression', 'suppression journalisée'); eq(log.old.id, 'pea-demo-energie', 'ligne complète gardée dans le journal');
  });

  await test('Tickers par ISIN : candidats (nouvelles lignes + lignes sans ticker), appliqués et journalisés', () => {
    const p = structuredClone(files.portfolio);
    delete p.holdings.find((h) => h.id === 'pea-exemple-industries').ticker;
    const d = diffPositions(read.positions, p, files.config, 'pea', profile);
    const cands = tickerCandidates(d, p, files.config, 'pea');
    eq(cands.map((c) => `${c.id}:${c.isNew}`).join(), 'pea-nouvelle-societe-fictive:true,pea-tracker-msci-exemple-fictif:true,pea-exemple-industries:false', 'candidats');
    assert(!cands.some((c) => c.id === 'pea-etf-monde'), 'ligne avec ticker ignorée');
    const none = { added: new Set(), changed: new Set(), removed: new Set() };
    const next = applyImport(p, d, none, { label: 't', now: NOW, tickers: { 'pea-exemple-industries': 'EXA.PA', 'pea-nouvelle-societe-fictive': 'NSF.PA' } });
    assert(validate(schemas.portfolio, next).length === 0, JSON.stringify(validate(schemas.portfolio, next).slice(0, 3)));
    eq(next.holdings.find((h) => h.id === 'pea-exemple-industries').ticker, 'EXA.PA', 'ticker posé sur la ligne existante');
    assert(!next.holdings.some((h) => h.id === 'pea-nouvelle-societe-fictive'), 'nouvelle ligne non cochée : ni ajoutée ni ticker');
    const log = next.changelog.at(-1);
    eq(`${log.target}.${log.field} ${log.old} -> ${log.new}`, 'pea-exemple-industries.ticker null -> EXA.PA', 'journal');
    const added = applyImport(p, d, { ...none, added: new Set(['pea-nouvelle-societe-fictive']) }, { label: 't', now: NOW, tickers: { 'pea-nouvelle-societe-fictive': 'NSF.PA' } });
    eq(added.holdings.find((h) => h.id === 'pea-nouvelle-societe-fictive').ticker, 'NSF.PA', 'ticker de la nouvelle ligne');
  });
}
