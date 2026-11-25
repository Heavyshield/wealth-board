# Wealth Board -- instructions for Claude

Personal net-worth dashboard. Static site (GitHub Pages), vanilla JS ES modules, no build step.
UI in French; code, comments, docs, JSON keys in English.
Footer must always read: "Outil de suivi, pas un conseil en investissement."

## Status (stages)
- [x] (a) data model, validation, holdings table, filters, inline edit, local working copy, tests
- [x] (b) KPIs (hero total, latent P&L, day change with coverage, price freshness) + 4 charts
- [x] (c) rules engine (config.rules), constraint meters (config.constraints), "À revoir" panel, editable metrics
- [x] (d) price providers: FX (Frankfurter > ECB), metals (gold-api), quotes (own Yahoo proxy), cache, fallback
- [x] (e) CSV position import (Boursorama profile) with column mapping, diff preview, per-line apply
- [x] (e+) editing: ticker assistant (ISIN -> Yahoo via proxy /search), line editor (add/edit/delete any class),
"Retirer les données d'exemple"
- [x] (f) storage = ONE file wealth-board.json on Google Drive, opened / saved by the user (no OAuth). The OAuth
  sync built first (commit 6aa2c45) was removed 2026-11-25 at the user's request: too convoluted.
- [x] (g) snapshot button (history.json, one per day), "Copier pour Claude" (Markdown + JSON), changelog view

## Layout
```
index.html          page shell (French UI)
styles.css          light/dark via custom properties, phone = card layout < 720px
src/app.js          bootstrap: load -> validate -> value -> render; conflicts; toasts
src/data.js         load data/*.json, cross-checks, working copy (localStorage), applyEdits + changelog
src/schema.js       minimal JSON Schema validator (subset), French error messages
src/valuation.js    pure valuation: prices, FX, metals, P&L split, totals in integer cents
src/table.js        holdings table (column defs, sort, filters, picker, inline edit)
src/charts.js       KPI tiles + charts (allocation donut, history line, actual vs target, P&L bars)
src/rules.js        pure: rule status per line, constraint evaluation, ranked review items
src/review.js       UI: "À revoir" list (click = jump to the line) + constraint meters
src/prices.js       orchestration: needs, localStorage cache + TTL, fallback chains, batching, mergeLive, persistPrices
src/providers/*.js  one adapter per source (common.js = interface + helpers); pure parse() tested on real fixtures
tools/yahoo-proxy-worker.js  Cloudflare Worker the user deploys (Yahoo has no CORS); self-contained
tests/prices.test.js + tests/fixtures/*.json  real API responses captured 2026-11-25
src/csv.js          tolerant CSV: UTF-8/BOM or Windows-1252, ; , tab, RFC 4180 quotes, FR/EN numbers
src/importer.js     column mapping via config.imports, diff vs one envelope, applyImport (changelog per change)
src/editors.js      dialogs: ticker assistant, line editor -- all via data.js
src/data-ui.js      "Données" window (open wealth-board.json / save it: share sheet or download) + header badge
src/gdrive.js       OPTIONAL desktop Google login: newest wealth-board.json, overwrite in place, trash old copies
src/claude-export.js  makeSnapshot / addSnapshot / buildClaudeExport (pure)
src/journal.js      changelog view, filter by author (Claude highlighted)
src/import-ui.js    "Importer CSV" dialog: format, envelope, file -> mapping + diff with checkboxes -> apply
tests/import.test.js + tests/fixtures/boursorama-fake-*.csv  FAKE exports (EN/FR headers, cp1252, missing column)
src/format.js       fr-FR formatting + parsing of typed numbers
data/*.json         portfolio / config / history (repo copy = FAKE sample data only)
schema/*.schema.json  one schema per data file
tests/index.html    browser test page (open /tests/), results in window.testResults
tests/compute_expected.py  independent Python/Decimal valuation -> tests/expected.json
```

## Data files (the contract)
Every file has `schema_version`, `revision` (integer), `updated_at` (ISO date-time, UTC).
**`revision` must be incremented on every write** -- by the app and by Claude. The app uses it
to detect that a file changed under a local copy and asks the user instead of overwriting.

### portfolio.json
- `market_snapshot.fx`: `{ base, as_of, source, rates }`, rates = "1 base = r currency" (ECB convention).
- `market_snapshot.spot.XAU|XAG|XPT|XPD`: `{ value, currency, per: oz|g|kg, as_of, source }`.
- `holdings[]`: `id` (stable kebab-case, never reused), `name`, `envelope` (id from config.envelopes),
  `asset_class` (id from config.asset_classes), `ticker?`, `isin?`, `region?`, `quantity`, `unit_cost`
  (in `currency`), `cost_fx_rate?` (FX rate at purchase, base->currency, isolates the currency effect),
  `currency`, `price_source`, `manual_price?` `{value, as_of, currency?, source?}`,
  `last_price?` (last known market price; optional `prev_close` enables the day change), `metal?` `{code, weight, unit: g|oz|kg, purity 0..1}`,
  `tags[]`, `notes`, `metrics?` `{per, pcf, net_debt_ebitda, as_of}`, `updated_at`.
- `accounts[]`: legacy (PEA ceiling widget removed 2026-11-25 at the user's request: PEA is full). Still accepted by
  the schema so old local copies load; ignored. Do not reintroduce a ceiling tracker unless asked.
- `metrics` may hold any numeric metric (`per`, `pcf`, `net_debt_ebitda`, `dividend_yield`...) + required `as_of`
  (date of the financial data, never invented) + optional `source`.
- `changelog[]`: `{ date, file, target, field, old, new, author: "user"|"claude", note? }`.

### config.json
`base_currency`, `locale`, `envelopes[] {id,label,institution,currency}`,
`asset_classes[] {id,label,pricing: quote|spot|par}`, `regions.by_country` (ISIN prefix -> label),
`regions.by_pricing` (label for par / spot lines, e.g. Liquidités / Métaux), `prices.stale_after_hours {quote,spot,fx}`,
`table.default_columns`, `allocation_targets {group_by, tolerance, weights}` (weights sum to 1, keys must exist),
`charts {max_slices, palette {light[], dark[]}}`, `sample_data` (the commit hook requires it on every data file),
`rules {metrics_max_age_days, items[]}`, `constraints[]` (see below).

## Rules and constraints (src/rules.js) -- JSON only, no code
- Rule: `{ id, label, metric, op: <=|<|>=|>, value, require_positive?, applies_to? {asset_class[], envelope[], tags_exclude[]}, why? }`.
  `require_positive`: a value <= 0 fails (loss-making PER). Missing metric -> "À compléter", never a pass.
  Line status, worst wins: breach > incomplete > stale (metrics older than metrics_max_age_days) > ok; `na` = no rule applies.
- Constraint types:
  - `share_cap` `{group_by, keys[], max?, min?}` -> share of total value; breach above max, warn below min.
  - `runway` `{monthly_budget, target_months, liquid: scope}` -> months = liquid value / budget; warn < target, breach < half.
- "À revoir" = rule breaches, missing/stale metrics, missing/stale prices, missing FX, constraints not OK,
  allocation gaps beyond tolerance; sorted by severity (3 critique, 2 à surveiller, 1 info) then money at stake.
- Wording stays descriptive (gaps, ratios), never "buy/sell": this is a tracking tool, not advice.

### history.json
`snapshots[] {date, base_currency, total, cost?, by_envelope?, by_asset_class?, by_currency?, live_share?, note?}`.

## Valuation rules (src/valuation.js, mirrored in tests/compute_expected.py)
1. Price priority: `manual_price` > class pricing. `par` -> 1 per unit (cash/accounts, value = quantity).
   `spot` -> one item = weight (in oz) x purity x spot per oz. `quote` -> live quote (stage d) or `last_price`.
   No price -> valued at `unit_cost`, status **missing** (never silently dropped).
2. Status badge per line: live / stale (older than `stale_after_hours`) / manual / balance / missing.
   The summary shows each status's share of total value.
3. Base value = local value / rate. Totals are summed in integer cents.
4. Cost in base = qty x unit_cost / `cost_fx_rate` (else today's rate, shown "taux d'achat inconnu").
   FX effect = cost at today's rate - cost at purchase rate; price effect = P&L - FX effect.
5. Region = `region` field > `regions.by_pricing[pricing]` > `regions.by_country[ISIN prefix]` > `unknown_label`.
6. Day change = qty x (price - prev_close) / rate, only for **live** prices with a `prev_close`
   (quotes, or spot `prev_close`). Shown with its coverage ("calculée sur 33 % de la valeur"); never 0 by default.

## Charts (src/charts.js) -- rules followed
- Chart.js 4.6.2 from cdnjs, `defer` + SRI sha512 in index.html. If it fails, a banner shows and tables still render.
- Every chart has a data table (beside it or under "Voir les données"): no value depends on hover or color.
- Categorical palette = config.charts.palette, validated (dataviz validator, 2026-11-25) against this app's
  surfaces (#ffffff light, #1b1f26 dark): CVD and normal-vision gates pass; 3 light slots are < 3:1 contrast,
  so the labelled table next to the donut is required, not optional.
- Colors follow the entity (config order for envelopes/classes, alphabetical otherwise), never the rank.
  Donut folds past `max_slices` into "Autres" (muted gray). Gains/losses use the blue/red diverging pair.
- Bars <= 18px, 4px rounded data end; lines 2px; one y-axis per chart; chart colors re-read on theme toggle.

## How to...
- **Add an asset**: append to `holdings` with a new unique `id`; envelope/asset_class must exist in config.
  Metals: `asset_class: "metal"`, `price_source: "spot"`, a `metal` block; one line per physical item type.
  Add a changelog entry (`author: "claude"`), bump `revision` and `updated_at`.
- **Add an asset class / envelope**: add to `config.asset_classes` / `config.envelopes` (pick `pricing`).
- **Add a rule**: append to `config.rules.items` (any metric name); add that metric + `as_of` to the holdings' `metrics`.
- **Edit data in the UI**: ✎ on a row (line editor), "+ Ajouter une ligne",
  "N ligne(s) sans ticker · Compléter" in the price line. data.js: addHolding / removeHolding /
  removeSampleData / applyEdits (dotted paths, objects compared by value, null removes a field).
- **Import a new CSV format** (other broker): add a profile to `config.imports` (`columns` aliases per field,
  `required`, `update_fields`, `envelope_default`); test with a FAKE file in tests/fixtures (only CSVs allowed there).
- **Add a constraint**: append to `config.constraints` with one of the 3 types above.
- **Add a price provider**: CORS-test it from a browser page on localhost first. Then one file in
  `src/providers/` (interface in common.js: id, kind, needs, batch, minIntervalMs, fetch, pure parse), register it in
  `PROVIDERS` (prices.js), add it to a chain in `config.providers`, capture a real response in tests/fixtures and test parse().
- **Change the data shape**: update the schema, `crossCheck` in data.js if needed, compute_expected.py, tests.

## Safe-edit checklist (Claude editing data files)
1. Read the file; never invent prices or metrics (metrics need a real `as_of`).
2. Edit; append one changelog entry per changed field (`author: "claude"`, `old`, `new`).
3. Bump `revision` by 1 and set `updated_at` (UTC, `Z`).
4. Validate: `python tests/compute_expected.py` (runs `jsonschema` on all 3 files), then open `/tests/`.
5. The repo copy of data/ stays FAKE (`"sample_data": true`). Real data lives on Drive / a local folder (stage f).
   The repo is PUBLIC (github.com/Heavyshield/wealth-board, served on GitHub Pages). `.githooks/pre-commit`
   blocks data files without `sample_data: true` and bank exports; `.claude/` is git-ignored.

## Conventions
- No framework, no bundler, no analytics, no third-party scripts except pinned cdnjs libs.
- UI prefs (theme, columns) in localStorage `wb.ui.*`; data working copy in `wb.working.<file>`.
- Must be served over http(s) (file:// blocks module/JSON loading; the page says so).
- Local dev: `python -m http.server 8770` in the repo, open http://localhost:8770/ and /tests/.

## Storage (src/data-ui.js, data.js makeBundle / readOpened)
- **Keep it simple (user rule, 2026-11-25):** Drive only stores what exists nowhere else (gold, account balances,
  settings). No OAuth, no sync engine, no background jobs. Propose before adding any storage machinery.
- The user's data = ONE file `wealth-board.json` on Google Drive (source of truth):
  `{ "format": "wealth-board/1", "saved_at", "portfolio": {...}, "config": {...}, "history": {...} }`, pretty-printed.
  Each part follows its schema in /schema. The board also opens the three files separately.
- Flow: Données → Ouvrir (file picker; phones offer Google Drive) -> working copy in localStorage
  (`wb.working.<file>` { data, dirty, base_revision }) -> edits mark it dirty (badge "Modifié · à enregistrer sur
  Drive") -> Enregistrer = navigator.share (phone: "Enregistrer dans Drive") or download (computer).
- Guards: opening over unsaved changes, or a file with a lower portfolio revision, asks for confirmation.
  The repo-sample conflict banner only applies while the working copy is still sample data.
- **Claude editing the data:** read `wealth-board.json` from Drive, edit the part(s), bump that part's `revision` +
  `updated_at`, add changelog entries (`author: "claude"`), validate against /schema, write the file back (or give it
  to the user to put on Drive). The user then re-opens it in the board.
- Optional desktop login (`config.drive.client_id`, empty = hidden): GIS token in memory, scope `drive` (full) because
  files saved from the phone's share sheet are not visible with drive.file. Code only touches files named
  wealth-board.json: open newest, offer to trash older copies, save = PATCH in place after a version check
  (changed since opened -> confirm). No background sync.
- `repo data/*.json` stay FAKE sample data (commit hook).

## Snapshot and export (src/claude-export.js)
- Snapshot = { date (local day), base_currency, total, cost, by_envelope, by_asset_class, by_currency, live_share };
  same day replaces (confirm). Saved to the history working copy (dirty) -> user saves wealth-board.json.
- Export for Claude = Markdown (summary, allocation, targets, review items, constraints, last 15 changelog entries
  with ISO dates) + one compact JSON block of all lines. Clipboard, or a textarea fallback when blocked.

## CSV import (src/importer.js)
- Real Boursorama export format is not publicly documented (checked 2026-11-25): "Positions" tab -> "Exporter en CSV",
  one account per file, name `export-positions-(comptables|instantanees)-dd-MM-yyyy_hh-mm-ss.csv` (verified on a real export 2026-11-25: mapping OK, 10 positions, fractional quantities). Columns are matched by alias
  (`config.imports.boursorama.columns`, case/accent-insensitive); the dialog shows the mapping found. If a column is
  not recognised, add its exact header to the aliases -- never hardcode in JS.
- Diff is per envelope and only for quote-priced classes (cash/accounts/metals untouched). Match by ISIN, then name.
  Added lines get id `<envelope>-<name-slug>`, class guessed from `etf_name_pattern`, NO ticker (to fill for live price).
- Deletions are ticked by default, except when deletions >= matched lines (wrong envelope / partial export): warning,
  all unticked. A deleted line is kept in full in the changelog (`old`). File prices become `last_price` only if newer
  (as_of = date in the file name, else the file's modification time).

## Prices (src/prices.js)
- Chains per kind in `config.providers` {fx, spot, quote, ttl_minutes, auto_refresh}. A provider whose setting is
  missing (`needs`) is skipped and reported "non configuré". Every failure is listed under "Détails"; nothing is invented.
- Holding: `ticker` (Yahoo format) used by all providers unless `symbols.{provider}` overrides; `price_source`
  "quote:<id>" forces one provider, "manual" never fetches. `manual_price` always wins in valuation.
- Cache `wb.cache.prices` (localStorage) keyed `provider:symbol`; settings `wb.settings.prices` (proxy URL, keys)
  stay in the browser -- never in data files or the repo.
- `mergeLive`: newest `as_of` wins between live cache and file (so prices Claude writes are not overwritten by older
  cache). FX block takes the oldest live as_of (conservative). "Mémoriser les cours" writes them into the file
  (last_price + market_snapshot, revision+1, one changelog entry `field: "prices"`).
- Ticker assistant: proxy `GET /search?isins=` (Yahoo search, cached 24 h at the edge) -> listings; best = first in
  `config.providers.preferred_exchanges`; quoteType EQUITY/ETF/MUTUALFUND suggests class equity/etf/fund. The user
  confirms each line (some ETFs resolve to a listing in another currency, e.g. IWDA.L in USD). Search fixtures use
  PUBLIC example ISINs only, never the user's holdings (public repo).
- Yahoo `chartPreviousClose` (range=1d) = close before the current session -> base for day change. GBp/GBX/ZAc/ILA are
  converted to major units. gold-api has no previous close: metals have no day change (shown as coverage, not 0).

## Verified APIs (browser fetch from localhost, 2026-11-24/25)
- FX: `https://api.frankfurter.dev/v1/latest?base=EUR` (ECB rates, CORS *, no key). Fallback: ECB SDMX
  `https://data-api.ecb.europa.eu/service/data/EXR/D.CHF.EUR.SP00.A?lastNObservations=1&format=jsondata`.
- Metals: `https://api.gold-api.com/price/XAU/EUR` (per oz, any currency, CORS ok, no key).
- Blocked from the browser (no CORS): Yahoo, Stooq, Boerse Frankfurt, Nasdaq Nordic, EODHD, Swissquote.
  Euronext live endpoints answer but the payload is encrypted. -> Yahoo only through tools/yahoo-proxy-worker.js.
- Equities: only the user's Yahoo proxy (`https://wealth-quotes.lasserre1992.workers.dev`, deployed 2026-11-25).
  Twelve Data was tried (free plan = US only) and removed 2026-11-25 to keep things simple; the app purges any
  stored key. A provider needing a key would go back through src/providers + `needs` (see "Add a price provider").
  Yahoo and Swissquote are CORS-blocked from the browser.
