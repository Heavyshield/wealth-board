// Stage g: snapshot, export for Claude; plus the optional Drive login's file calls (fake Drive).

import { makeSnapshot, addSnapshot, buildClaudeExport } from '../src/claude-export.js';
import { driveFiles } from '../src/gdrive.js';

export async function stageGTests({ test, assert, eq, files, schemas, validate, NOW, rows, expected }) {
  await test('Relevé : total = référence Python, répartitions cohérentes, fichier valide', () => {
    const s = makeSnapshot(rows, files.config, NOW);
    eq(Math.round(s.total * 100), expected.total_value_cents, 'total au centime');
    for (const k of ['by_envelope', 'by_asset_class', 'by_currency']) {
      eq(Math.round(Object.values(s[k]).reduce((a, b) => a + b, 0) * 100), expected.total_value_cents, `${k} somme = total`);
    }
    assert(s.live_share > 0 && s.live_share < 1, 'part en direct');
    const { history, replaced } = addSnapshot(files.history, s, NOW);
    eq(replaced, false, 'ajout'); eq(history.snapshots.at(-1).date, s.date, 'dernier = aujourd’hui');
    eq(history.revision, files.history.revision + 1, 'révision');
    assert(validate(schemas.history, history).length === 0, JSON.stringify(validate(schemas.history, history).slice(0, 2)));
    const again = addSnapshot(history, { ...s, total: 1 }, NOW);
    eq(again.replaced, true, 'même jour remplacé'); eq(again.history.snapshots.length, history.snapshots.length, 'pas de doublon');
  });

  await test('Export pour Claude : synthèse, à revoir, journal, JSON exact', () => {
    const review = [{ severity: 3, title: 'Poche métaux', detail: '20,8 % > 20 %' }];
    const p = structuredClone(files.portfolio);
    p.changelog.push({ date: '2026-11-24T21:00:00Z', file: 'portfolio', target: 'livret-a', field: 'quantity', old: 12000, new: 12500, author: 'claude' });
    const text = buildClaudeExport({ rows, files: { ...files, portfolio: p }, review, now: NOW });
    assert(text.includes('Données personnelles, à ne pas partager.') && !text.includes('pas un conseil en investissement'), 'avertissement');
    assert(text.includes('DONNÉES D’EXEMPLE'), 'exemple signalé');
    assert(text.includes('[critique] Poche métaux'), 'à revoir');
    assert(text.includes('claude · livret-a.quantity : 12000 → 12500'), 'modification de Claude listée');
    const json = JSON.parse(text.split('```json\n')[1].split('\n```')[0]);
    eq(json.holdings.length, rows.length, 'toutes les lignes');
    eq(Math.round(json.total * 100), expected.total_value_cents, 'total exact');
    eq(json.holdings.find((h) => h.id === 'pea-demo-energie').price_status, 'stale', 'statut de prix');
  });

  await test('Drive (connexion optionnelle) : plus récent d’abord, remplacement sur place, corbeille', async () => {
    const calls = [];
    const fake = async (url, init = {}) => {
      calls.push(`${init.method ?? 'GET'} ${url.replace('https://www.googleapis.com', '')}`);
      const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
      if (url.includes('/files?q=')) return ok({ files: [{ id: 'new', version: '9', modifiedTime: '2026-11-25T10:00:00Z' }, { id: 'old', version: '3' }] });
      if (url.includes('alt=media')) return ok({ format: 'wealth-board/1' });
      return ok({ id: 'new', version: '10' });
    };
    const d = driveFiles('tok', 'wealth-board.json', fake);
    const list = await d.list();
    eq(list[0].id, 'new', 'plus récent en premier');
    assert(decodeURIComponent(calls[0]).includes("name='wealth-board.json' and trashed=false") && calls[0].includes('orderBy=modifiedTime%20desc'), calls[0]);
    eq((await d.update('new', '{}')).version, '10', 'nouvelle version');
    assert(calls.at(-1).startsWith('PATCH /upload/drive/v3/files/new?uploadType=media'), 'remplacé sur place (pas de doublon)');
    await d.trash('old');
    assert(calls.at(-1).startsWith('PATCH /drive/v3/files/old'), 'corbeille');
    let msg = '';
    try { await driveFiles('tok', 'x', async () => ({ ok: false, status: 401, json: async () => ({}) })).list(); } catch (e) { msg = e.message; }
    assert(/expirée/.test(msg), 'jeton expiré expliqué');
  });
}
