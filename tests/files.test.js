// Single-file storage: wealth-board.json (portfolio + config + history) opened from / saved to Drive.

import { makeBundle, readOpened, BUNDLE_FORMAT } from '../src/data.js';

export async function filesTests({ test, assert, eq, files, schemas, validate, NOW }) {
  await test('Fichier unique : aller-retour sans perte, JSON lisible', () => {
    const text = makeBundle(files, NOW);
    const obj = JSON.parse(text);
    eq(obj.format, BUNDLE_FORMAT, 'format'); eq(obj.saved_at, '2026-11-24T22:00:00Z', 'date');
    assert(text.includes('\n  "portfolio": {'), 'indenté (lisible par Claude et à la main)');
    const back = readOpened([{ name: 'wealth-board.json', obj }]);
    eq(back.problems.length, 0, 'aucun problème');
    for (const f of ['portfolio', 'config', 'history']) {
      eq(JSON.stringify(back.files[f]), JSON.stringify(files[f]), `${f} identique`);
      assert(validate(schemas[f], back.files[f]).length === 0, `${f} valide`);
    }
  });

  await test('Ouverture : fichiers séparés acceptés, fichier inconnu signalé', () => {
    const r = readOpened([
      { name: 'portfolio.json', obj: files.portfolio },
      { name: 'history.json', obj: files.history },
      { name: 'notes.json', obj: { hello: 1 } },
    ]);
    eq(Object.keys(r.files).join(), 'portfolio,history', 'deux fichiers reconnus');
    assert(r.problems[0].includes('notes.json'), 'inconnu signalé');
  });
}
