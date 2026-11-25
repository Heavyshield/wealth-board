// Drive sync logic (no DOM). Local working copy = instant/offline cache; Drive = shared master.
// Each local record knows { dirty, drive_version }: the Drive version it was last synced with and
// whether it has changes not yet sent. Drive's `version` increases on ANY change (app, Claude through a
// connector, another device), so it catches edits even when `revision` was not bumped.
//
//   local clean + Drive unchanged      -> nothing
//   local clean + Drive changed        -> take Drive (pull)
//   local dirty + Drive unchanged      -> send local (push)
//   local dirty + Drive changed        -> CONFLICT: ask (keep mine / keep Drive's / see diff). Never silent.
//   Drive file invalid JSON or schema  -> never overwritten silently: ask, default = keep Drive's file untouched.

export const pretty = (data) => JSON.stringify(data, null, 2) + '\n';

/**
 * deps: {
 *   client,                               // createDriveClient(...)
 *   files: ['portfolio', 'config', 'history'],
 *   folderName,
 *   state: { load(), save(s) },           // persisted { folder_id, ids: {file: id}, last_sync }
 *   getLocal(file) -> { data, dirty, drive_version } (data always present: working copy or repo default)
 *   setLocal(file, data, { dirty, drive_version })
 *   validate(file, data) -> errors[]
 *   resolveConflict({ file, mine, theirs, meta, reason }) -> Promise<'mine' | 'theirs' | null>
 * }
 */
export function createSync(deps) {
  const { client, files, folderName, state, getLocal, setLocal, validate, resolveConflict } = deps;

  async function readRemote(id) {
    const text = await client.readText(id);
    try { return { data: JSON.parse(text) }; } catch (e) { return { data: null, error: `JSON illisible sur Drive : ${e.message}` }; }
  }

  async function settle(file, id, local, meta) {
    const remote = await readRemote(id);
    const errs = remote.data ? validate(file, remote.data) : [];
    const invalid = remote.error ?? (errs.length ? `fichier Drive invalide : ${errs[0].path} : ${errs[0].message}` : null);
    const remoteChanged = String(local.drive_version ?? '') !== String(meta.version);
    if (!invalid && !local.dirty) {
      if (!remoteChanged) return 'same';
      setLocal(file, remote.data, { dirty: false, drive_version: meta.version });
      return 'pulled';
    }
    if (!invalid && local.dirty && !remoteChanged) return push(file, id, local);
    const choice = await resolveConflict({ file, mine: local.data, theirs: remote.data, meta, reason: invalid ?? 'both' });
    if (choice === 'mine') {
      const m = await client.updateText(id, pretty(local.data));
      setLocal(file, local.data, { dirty: false, drive_version: m.version });
      return 'kept-mine';
    }
    if (choice === 'theirs' && remote.data && !invalid) {
      setLocal(file, remote.data, { dirty: false, drive_version: meta.version });
      return 'kept-theirs';
    }
    return 'unresolved';
  }

  async function push(file, id, local) {
    const m = await client.updateText(id, pretty(local.data));
    setLocal(file, local.data, { dirty: false, drive_version: m.version });
    return 'pushed';
  }

  return {
    /** Connect: find/create the folder, then reconcile every file. Returns { file: outcome }. */
    async connect() {
      const s = state.load() ?? {};
      const folderId = await client.ensureFolder(folderName);
      const listed = await client.listFiles(folderId);
      const ids = {};
      const report = {};
      for (const file of files) {
        const local = getLocal(file);
        const meta = listed[`${file}.json`];
        if (!meta) {
          const created = await client.createText(folderId, `${file}.json`, pretty(local.data));
          setLocal(file, local.data, { dirty: false, drive_version: created.version });
          ids[file] = created.id;
          report[file] = 'created';
          continue;
        }
        ids[file] = meta.id;
        report[file] = await settle(file, meta.id, local, meta);
      }
      state.save({ ...s, folder_id: folderId, ids, last_sync: new Date().toISOString() });
      return report;
    },

    /** Send local changes of one file (after an edit). Checks Drive's version first. */
    async push(file) {
      const s = state.load();
      const id = s?.ids?.[file];
      if (!id) return 'not-connected';
      const local = getLocal(file);
      if (!local.dirty) return 'clean';
      const meta = await client.getMeta(id);
      const out = String(meta.version) === String(local.drive_version ?? '') ? await push(file, id, local) : await settle(file, id, local, meta);
      state.save({ ...s, last_sync: new Date().toISOString() });
      return out;
    },

    /** Re-read every file from Drive (e.g. after Claude edited them). Same rules as connect. */
    async pull() {
      const s = state.load();
      if (!s?.ids) return {};
      const report = {};
      for (const file of files) {
        const id = s.ids[file];
        if (!id) continue;
        report[file] = await settle(file, id, getLocal(file), await client.getMeta(id));
      }
      state.save({ ...s, last_sync: new Date().toISOString() });
      return report;
    },
  };
}

/**
 * Human-readable differences between two versions of a data file (for the conflict dialog).
 * Returns [string] in French. Holdings compared by id and field; changelog entries only in one side listed.
 */
export function summarizeDiff(mine, theirs) {
  const out = [];
  if (!theirs) return ['Le fichier sur Drive est illisible : rien à comparer.'];
  const val = (v) => (v && typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v));
  if (mine.holdings || theirs.holdings) {
    const a = new Map((mine.holdings ?? []).map((h) => [h.id, h]));
    const b = new Map((theirs.holdings ?? []).map((h) => [h.id, h]));
    for (const [id, h] of b) if (!a.has(id)) out.push(`Drive seulement : ligne « ${h.name} »`);
    for (const [id, h] of a) if (!b.has(id)) out.push(`Ici seulement : ligne « ${h.name} »`);
    for (const [id, h] of a) {
      const t = b.get(id);
      if (!t) continue;
      for (const k of new Set([...Object.keys(h), ...Object.keys(t)])) {
        if (k === 'updated_at') continue;
        if (JSON.stringify(h[k]) !== JSON.stringify(t[k])) out.push(`« ${h.name} » · ${k} : ici ${val(h[k])} / Drive ${val(t[k])}`);
      }
    }
  }
  for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    if (['holdings', 'changelog', 'revision', 'updated_at'].includes(k)) continue;
    if (JSON.stringify(mine[k]) !== JSON.stringify(theirs[k])) out.push(`${k} : différent`);
  }
  const seen = new Set((mine.changelog ?? []).map((c) => JSON.stringify(c)));
  for (const c of theirs.changelog ?? []) {
    if (!seen.has(JSON.stringify(c))) out.push(`Journal Drive : ${c.date.slice(0, 16).replace('T', ' ')} ${c.author} · ${c.target}.${c.field} ${val(c.old)} → ${val(c.new)}`);
  }
  return out.length ? out : ['Contenus identiques (seuls la révision ou les dates diffèrent).'];
}
