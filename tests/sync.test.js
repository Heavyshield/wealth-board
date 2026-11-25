// Stage f tests: Drive client + sync against a FAKE Drive implementing the REST calls we use
// (files.list with q, create folder, get meta, get media, PATCH upload media, POST upload multipart)
// with Drive's semantics: every content change increments `version`; 401 when the token is stale.

import { createDriveClient } from '../src/drive.js';
import { createSync, summarizeDiff, pretty } from '../src/sync.js';

function fakeDrive() {
  const files = new Map(); // id -> { id, name, parents, mimeType, appProperties, version, text, modifiedTime }
  let n = 0, badTokens = 0;
  const meta = (f) => ({ id: f.id, name: f.name, version: String(f.version), modifiedTime: f.modifiedTime, lastModifyingUser: { displayName: f.by ?? 'Moi' } });
  const ok = (body, text) => ({ ok: true, status: 200, json: async () => body, text: async () => text ?? JSON.stringify(body) });
  const put = (f) => { f.modifiedTime = new Date(Date.UTC(2026, 10, 25, 10, 0, n)).toISOString(); files.set(f.id, f); return f; };
  return {
    files,
    expireTokenOnce() { badTokens = 1; },
    /** Someone else (Claude through a connector, another device) rewrites a file. */
    externalEdit(name, text, by = 'Claude') { const f = [...files.values()].find((x) => x.name === name); f.text = text; f.version++; f.by = by; put(f); },
    async fetch(url, init = {}) {
      if (badTokens) { badTokens--; return { ok: false, status: 401, json: async () => ({ error: { message: 'Invalid Credentials' } }) }; }
      const u = new URL(url);
      const method = init.method ?? 'GET';
      const id = u.pathname.match(/files\/([^/]+)$/)?.[1];
      if (method === 'GET' && !id) {
        const q = u.searchParams.get('q');
        let list = [...files.values()].filter((f) => !f.trashed);
        if (q.includes("value='folder'")) list = list.filter((f) => f.appProperties?.wealthboard === 'folder');
        const parent = q.match(/'([^']+)' in parents/)?.[1];
        if (parent) list = list.filter((f) => f.parents?.includes(parent));
        return ok({ files: list.map((f) => ({ ...meta(f), name: f.name })) });
      }
      if (method === 'GET' && id) {
        const f = files.get(id);
        if (!f) return { ok: false, status: 404, json: async () => ({ error: { message: 'File not found' } }) };
        return u.searchParams.get('alt') === 'media' ? ok(null, f.text) : ok(meta(f));
      }
      if (method === 'POST' && u.pathname === '/drive/v3/files') {
        const m = JSON.parse(init.body);
        const f = put({ id: `id${++n}`, version: 1, ...m });
        return ok({ id: f.id });
      }
      if (method === 'POST' && u.pathname === '/upload/drive/v3/files') {
        const boundary = init.headers['Content-Type'].split('boundary=')[1];
        const parts = init.body.split(`--${boundary}`).slice(1, -1).map((p) => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
        const m = JSON.parse(parts[0]);
        const f = put({ id: `id${++n}`, version: 1, ...m, text: parts[1] });
        return ok(meta(f));
      }
      if (method === 'PATCH' && id) {
        const f = files.get(id);
        f.text = init.body; f.version++; f.by = 'Moi'; put(f);
        return ok(meta(f));
      }
      return { ok: false, status: 400, json: async () => ({ error: { message: `unexpected ${method} ${u.pathname}` } }) };
    },
  };
}

/** A device: its own local store + sync wired like data-ui.js does. */
function device(drive, defaults, validate, resolver) {
  const local = new Map(); // file -> { data, dirty, drive_version }
  let stateStore = null;
  let tokenOk = true;
  const client = createDriveClient({ fetch: (u, i) => drive.fetch(u, i), getToken: async () => 'tok', onUnauthorized: () => { tokenOk = false; } });
  const sync = createSync({
    client, files: ['portfolio', 'config', 'history'], folderName: 'Wealth Board',
    state: { load: () => stateStore, save: (s) => { stateStore = s; } },
    getLocal: (f) => local.get(f) ?? { data: defaults[f], dirty: false },
    setLocal: (f, data, extra) => local.set(f, { data, ...extra }),
    validate, resolveConflict: async (c) => { resolver.calls.push(c); return resolver.answer; },
  });
  return { local, sync, edit(f, fn) { const d = structuredClone((local.get(f) ?? { data: defaults[f] }).data); fn(d); local.set(f, { ...local.get(f), data: d, dirty: true }); }, get tokenInvalidated() { return !tokenOk; } };
}

export async function syncTests({ test, assert, eq, files, schemas, validate }) {
  const valid = (f, d) => validate(schemas[f], d);
  const defaults = { portfolio: files.portfolio, config: files.config, history: files.history };
  const textOf = (drive, name) => [...drive.files.values()].find((f) => f.name === name)?.text;

  await test('Drive : 1re connexion = dossier + 3 fichiers créés depuis ce navigateur', async () => {
    const drive = fakeDrive();
    const r = { calls: [], answer: null };
    const a = device(drive, defaults, valid, r);
    a.edit('portfolio', (p) => { p.holdings[0].quantity = 41; });
    const rep = await a.sync.connect();
    eq(JSON.stringify(rep), JSON.stringify({ portfolio: 'created', config: 'created', history: 'created' }), 'rapport');
    eq([...drive.files.values()].filter((f) => f.appProperties?.wealthboard === 'folder').length, 1, 'un dossier marqué');
    eq(JSON.parse(textOf(drive, 'portfolio.json')).holdings[0].quantity, 41, 'contenu envoyé');
    assert(textOf(drive, 'portfolio.json').includes('\n  "holdings"'), 'JSON lisible (indenté) pour Claude');
    eq(a.local.get('portfolio').dirty, false, 'local propre après envoi');
  });

  await test('Drive : 2e appareil retrouve le dossier et prend la version Drive (pas l’exemple)', async () => {
    const drive = fakeDrive();
    const r = { calls: [], answer: null };
    const a = device(drive, defaults, valid, r);
    a.edit('portfolio', (p) => { p.holdings[0].quantity = 77; });
    await a.sync.connect();
    const b = device(drive, defaults, valid, r);
    const rep = await b.sync.connect();
    eq(rep.portfolio, 'pulled', 'téléchargé'); eq(b.local.get('portfolio').data.holdings[0].quantity, 77, 'données de A');
    eq([...drive.files.values()].length, 4, 'aucun doublon créé');
    eq(r.calls.length, 0, 'aucun conflit');
  });

  await test('Drive : modification par Claude reprise au rechargement (version Drive)', async () => {
    const drive = fakeDrive();
    const r = { calls: [], answer: null };
    const a = device(drive, defaults, valid, r);
    await a.sync.connect();
    const p = JSON.parse(textOf(drive, 'portfolio.json'));
    p.holdings[1].notes = 'Revue par Claude';
    p.changelog.push({ date: '2026-11-25T10:00:00Z', file: 'portfolio', target: p.holdings[1].id, field: 'notes', old: p.holdings[1].notes, new: 'Revue par Claude', author: 'claude' });
    drive.externalEdit('portfolio.json', pretty(p)); // revision NOT bumped on purpose: Drive version still catches it
    eq((await a.sync.pull()).portfolio, 'pulled', 'repris');
    eq(a.local.get('portfolio').data.holdings[1].notes, 'Revue par Claude', 'contenu');
  });

  await test('Drive : modif locale + Drive inchangé = envoi ; + Drive modifié = conflit demandé', async () => {
    const drive = fakeDrive();
    const r = { calls: [], answer: null };
    const a = device(drive, defaults, valid, r);
    await a.sync.connect();
    a.edit('portfolio', (p) => { p.holdings[0].quantity = 50; });
    eq(await a.sync.push('portfolio'), 'pushed', 'envoyé');
    eq(JSON.parse(textOf(drive, 'portfolio.json')).holdings[0].quantity, 50, 'Drive à jour');
    // conflict: Claude edits Drive, user edits locally
    const p = JSON.parse(textOf(drive, 'portfolio.json')); p.holdings[0].notes = 'Claude'; drive.externalEdit('portfolio.json', pretty(p));
    a.edit('portfolio', (q) => { q.holdings[0].quantity = 60; });
    r.answer = null;
    eq(await a.sync.push('portfolio'), 'unresolved', 'décider plus tard');
    eq(JSON.parse(textOf(drive, 'portfolio.json')).holdings[0].notes, 'Claude', 'Drive non écrasé');
    eq(a.local.get('portfolio').data.holdings[0].quantity, 60, 'local non écrasé');
    eq(r.calls.at(-1).meta.lastModifyingUser.displayName, 'Claude', 'auteur montré');
    r.answer = 'theirs';
    eq(await a.sync.push('portfolio'), 'kept-theirs', 'garder Drive');
    eq(a.local.get('portfolio').data.holdings[0].notes, 'Claude', 'local = Drive');
    a.edit('portfolio', (q) => { q.holdings[0].quantity = 70; });
    const p2 = JSON.parse(textOf(drive, 'portfolio.json')); p2.holdings[0].notes = 'Claude 2'; drive.externalEdit('portfolio.json', pretty(p2));
    r.answer = 'mine';
    eq(await a.sync.push('portfolio'), 'kept-mine', 'garder la mienne');
    eq(JSON.parse(textOf(drive, 'portfolio.json')).holdings[0].quantity, 70, 'Drive = local');
  });

  await test('Drive : fichier corrompu sur Drive jamais écrasé sans accord', async () => {
    const drive = fakeDrive();
    const r = { calls: [], answer: null };
    const a = device(drive, defaults, valid, r);
    await a.sync.connect();
    drive.externalEdit('portfolio.json', '{ "holdings": [ oups');
    eq((await a.sync.pull()).portfolio, 'unresolved', 'non résolu');
    assert(/JSON illisible/.test(r.calls.at(-1).reason), 'raison montrée');
    eq(textOf(drive, 'portfolio.json'), '{ "holdings": [ oups', 'Drive intact');
    drive.externalEdit('portfolio.json', pretty({ ...files.portfolio, holdings: [{ id: 'x' }] }));
    await a.sync.pull();
    assert(/invalide/.test(r.calls.at(-1).reason), 'schéma invalide détecté');
  });

  await test('Drive : jeton expiré (401) = renouvelé puis requête rejouée', async () => {
    const drive = fakeDrive();
    const a = device(drive, defaults, valid, { calls: [], answer: null });
    await a.sync.connect();
    drive.expireTokenOnce();
    eq(JSON.stringify(await a.sync.pull()), JSON.stringify({ portfolio: 'same', config: 'same', history: 'same' }), 'rejoué');
    assert(a.tokenInvalidated, 'jeton invalidé');
  });

  await test('Différences lisibles : lignes, champs, journal de Claude', () => {
    const mine = structuredClone(files.portfolio), theirs = structuredClone(files.portfolio);
    theirs.holdings[0].quantity = 99;
    theirs.holdings.push({ ...theirs.holdings[1], id: 'nouvelle', name: 'Nouvelle ligne' });
    theirs.changelog.push({ date: '2026-11-25T10:00:00Z', target: 'x', field: 'notes', old: null, new: 'y', author: 'claude' });
    const d = summarizeDiff(mine, theirs).join('\n');
    assert(d.includes('Drive seulement : ligne « Nouvelle ligne »'), d);
    assert(d.includes('quantity : ici 40 / Drive 99'), d);
    assert(d.includes('claude'), 'entrée de journal de Claude');
  });
}
