"""Independent reference valuation (the outside judge for src/valuation.js).

Re-implements the valuation spec from CLAUDE.md in Python with Decimal arithmetic,
reading only data/*.json, and writes tests/expected.json. tests.html then checks the
JS engine against it to the cent. Optionally validates data files with the
`jsonschema` package (an independent validator) when it is installed.

Run from the repo root:  python tests/compute_expected.py
"""
import json
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
D = lambda x: Decimal(str(x))
OZ_G = Decimal("31.1034768")
TO_OZ = {"oz": Decimal(1), "g": 1 / OZ_G, "kg": 1000 / OZ_G}


def load(name):
    return json.loads((ROOT / "data" / f"{name}.json").read_text(encoding="utf-8"))


def cents(x):
    # JS Math.round rounds half up (toward +inf); match it for positive values.
    return int((x * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def main():
    pf, cfg = load("portfolio"), load("config")
    base = cfg["base_currency"]
    pricing = {c["id"]: c["pricing"] for c in cfg["asset_classes"]}
    rates = {k: D(v) for k, v in pf["market_snapshot"]["fx"]["rates"].items()}
    rates[base] = Decimal(1)
    spot = pf["market_snapshot"]["spot"]

    from datetime import datetime, timezone
    now = datetime(2026, 11, 24, 22, 0, tzinfo=timezone.utc)  # same fixed clock as tests.js
    stale_h = cfg.get("prices", {}).get("stale_after_hours", {})
    fresh = lambda iso, kind: (now - datetime.fromisoformat(iso.replace("Z", "+00:00"))).total_seconds() / 3600 <= stale_h.get(kind, 72)
    lines, total_v, total_c, total_day = {}, 0, 0, 0
    for h in pf["holdings"]:
        qty, cost = D(h["quantity"]), D(h["unit_cost"])
        kind = pricing[h["asset_class"]]
        prev = None  # previous close per unit, only for fresh market prices
        if "manual_price" in h:
            price, cur = D(h["manual_price"]["value"]), h["manual_price"].get("currency", h["currency"])
        elif kind == "par":
            price, cur = Decimal(1), h["currency"]
        elif kind == "spot":
            s, m = spot[h["metal"]["code"]], h["metal"]
            per_oz = D(s["value"]) / TO_OZ[s["per"]]
            price, cur = D(m["weight"]) * TO_OZ[m["unit"]] * D(m["purity"]) * per_oz, s["currency"]
            if "prev_close" in s and fresh(s["as_of"], "spot"):
                prev = D(m["weight"]) * TO_OZ[m["unit"]] * D(m["purity"]) * D(s["prev_close"]) / TO_OZ[s["per"]]
        else:
            p = h["last_price"]
            price, cur = D(p["value"]), p.get("currency", h["currency"])
            if "prev_close" in p and fresh(p["as_of"], "quote"):
                prev = D(p["prev_close"])
        value_base = qty * price / rates[cur]
        cost_rate = D(h["cost_fx_rate"]) if h["currency"] != base and "cost_fx_rate" in h else rates[h["currency"]]
        cost_base = qty * cost / cost_rate
        lines[h["id"]] = {"value_cents": cents(value_base), "cost_cents": cents(cost_base)}
        total_v += cents(value_base)
        total_c += cents(cost_base)
        if prev is not None:
            day = qty * (price - prev) / rates[cur]
            lines[h["id"]]["day_cents"] = cents(day)
            total_day += cents(day)

    out = {"generated_by": "tests/compute_expected.py", "total_value_cents": total_v, "total_cost_cents": total_c, "total_day_cents": total_day, "lines": lines}
    (ROOT / "tests" / "expected.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"total value {total_v / 100:.2f} {base}, cost {total_c / 100:.2f} {base}, day {total_day / 100:.2f}, {len(lines)} lines")

    try:
        import jsonschema
    except ImportError:
        print("jsonschema not installed: skipped independent schema check (pip install jsonschema)")
        return
    ok = True
    for name in ("portfolio", "config", "history"):
        schema = json.loads((ROOT / "schema" / f"{name}.schema.json").read_text(encoding="utf-8"))
        errs = list(jsonschema.Draft202012Validator(schema).iter_errors(load(name)))
        ok &= not errs
        print(f"jsonschema {name}: {'OK' if not errs else f'{len(errs)} error(s)'}")
        for e in errs[:10]:
            print("   ", list(e.absolute_path), e.message)
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
