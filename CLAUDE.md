# Wealth Board -- instructions for Claude

Personal net-worth dashboard. Static site (GitHub Pages), vanilla JS ES modules, no build step.
UI in French; code, comments, docs, JSON keys in English.
Footer must always read: "Outil de suivi, pas un conseil en investissement."

## Status (stages)
- [x] (a) data model, validation, holdings table, filters, inline edit, local working copy, tests
- [ ] (b) charts + KPIs (Chart.js from cdnjs, pinned)
- [ ] (c) rules engine + constraint widgets (rules in config.json only)
- [ ] (d) price providers (adapter per provider, fallback chain, localStorage TTL cache)
- [ ] (e) Boursorama CSV import with diff preview
- [ ] (f) Google Drive sync (GIS, drive.file) + File System Access fallback + conflicts
- [ ] (g) "Export for Claude" + snapshot button

## Layout
```
index.html          page shell (French UI)
styles.css          light/dark via custom properties, phone = card layout < 720px
src/app.js          bootstrap: load -> validate -> value -> render; conflicts; toasts
src/data.js         load data/*.json, cross-checks, working copy (localStorage), applyEdits + changelog
src/schema.js       minimal JSON Schema validator (subset), French error messages
src/valuation.js    pure valuation: prices, FX, metals, P&L split, totals in integer cents
src/table.js        holdings table (column defs, sort, filters, picker, inline edit)
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
  `last_price?` (last known market price), `metal?` `{code, weight, unit: g|oz|kg, purity 0..1}`,
  `tags[]`, `notes`, `metrics?` `{per, pcf, net_debt_ebitda, as_of}`, `updated_at`.
- `changelog[]`: `{ date, file, target, field, old, new, author: "user"|"claude", note? }`.

### config.json
`base_currency`, `locale`, `envelopes[] {id,label,institution,currency}`,
`asset_classes[] {id,label,pricing: quote|spot|par}`, `regions.by_country` (ISIN prefix -> label),
`prices.stale_after_hours {quote,spot,fx}`, `table.default_columns`.

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
5. Region = `region` field > `config.regions.by_country[ISIN prefix]` > `unknown_label`.

## How to...
- **Add an asset**: append to `holdings` with a new unique `id`; envelope/asset_class must exist in config.
  Metals: `asset_class: "metal"`, `price_source: "spot"`, a `metal` block; one line per physical item type.
  Add a changelog entry (`author: "claude"`), bump `revision` and `updated_at`.
- **Add an asset class / envelope**: add to `config.asset_classes` / `config.envelopes` (pick `pricing`).
- **Add a rule** (stage c): config only, never code.
- **Add a price provider** (stage d): one file in `src/providers/`, common interface; CORS-test first.
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

## Verified APIs (browser fetch from localhost, 2026-11-24)
- FX: `https://api.frankfurter.dev/v1/latest?base=EUR` (ECB rates, CORS *, no key). Fallback: ECB SDMX
  `https://data-api.ecb.europa.eu/service/data/EXR/D.CHF.EUR.SP00.A?lastNObservations=1&format=jsondata`.
- Metals: `https://api.gold-api.com/price/XAU` (USD, CORS ok, no key).
- Equities: Twelve Data / Alpha Vantage (CORS *, free key needed; Euronext/Nordic coverage unverified).
  Yahoo and Swissquote are CORS-blocked from the browser.
