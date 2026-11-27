// Save rules, pure (tested): what one "Enregistrer" writes, when Drive really changed, which parts of an
// opened file are older than what is shown. No DOM, no network.
//
// One save = current prices written into the file + today's snapshot (one per local day, replaced on re-save)
// + the file sent to Drive / downloaded. No background sync: nothing happens without the user's click.

import { persistPrices } from './prices.js';
import { makeSnapshot, addSnapshot } from './claude-export.js';

export const PARTS = ['portfolio', 'config', 'history'];

/**
 * Files to save, from the files shown. `merged` = prices.mergeLive result (live prices in use), `rows` = valued rows.
 * Prices are written only when a live price is newer than the file; the snapshot only for real data.
 * Returns { files, changed: [part], snapshot_date }.
 */
export function prepareSave({ files, merged, rows, config, now = new Date() }) {
  const next = { ...files };
  const changed = [];
  const liveNewer = merged && Object.keys(merged.quotes ?? {}).length > 0;
  const marketChanged = merged && JSON.stringify(merged.portfolio?.market_snapshot ?? null) !== JSON.stringify(files.portfolio.market_snapshot ?? null);
  if (liveNewer || marketChanged) {
    next.portfolio = persistPrices(files.portfolio, merged, 'user', now);
    changed.push('portfolio');
  }
  let snapshotDate = null;
  if (!files.portfolio.sample_data && rows?.length) {
    const snap = makeSnapshot(rows, config, now);
    next.history = addSnapshot(files.history, snap, now).history;
    changed.push('history');
    snapshotDate = snap.date;
  }
  return { files: next, changed, snapshot_date: snapshotDate };
}

/**
 * Has the Drive file changed since we last opened / saved it? Compares the content checksum: Drive bumps
 * `version` by itself after an upload (that made our own save look foreign). Version only as a fallback.
 */
export function remoteChanged(target, meta) {
  if (!target) return false;
  if (target.md5Checksum && meta?.drive_md5) return target.md5Checksum !== meta.drive_md5;
  return String(target.version) !== String(meta?.drive_version ?? '');
}

/** Parts of an opened file whose revision is older than the one shown (every part, not only the portfolio). */
export function olderParts(opened, shown) {
  return PARTS.filter((p) => opened[p] && shown[p] && typeof opened[p].revision === 'number' && opened[p].revision < shown[p].revision);
}

/** Dated name for the "keep both" copy of the Drive version, e.g. "wealth-board (copie 2026-11-27 08h12).json". */
export function copyName(base, now = new Date()) {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 6e4).toISOString();
  return base.replace(/\.json$/, '') + ` (copie ${d.slice(0, 10)} ${d.slice(11, 13)}h${d.slice(14, 16)}).json`;
}
