#!/usr/bin/env python3
"""
Fetch TWSE 三大法人買賣金額統計表 (BFI82U) for a date range and
emit FinMind-compatible JSON so the front-end / proxy can drop it in.

Output:
{
  "msg": "success",
  "status": 200,
  "source": "twse",
  "data": [
    {"date": "YYYY-MM-DD", "name": "Foreign_Investor",    "buy": <int_TWD>, "sell": <int_TWD>},
    {"date": "YYYY-MM-DD", "name": "Foreign_Dealer_Self", "buy": <int_TWD>, "sell": <int_TWD>},
    ...
  ]
}
"""
from __future__ import annotations
import argparse, json, sys, time, urllib.request, urllib.error
from datetime import date, datetime, timedelta

TWSE = "https://www.twse.com.tw/rwd/zh/fund/BFI82U"
FOREIGN_MAIN = "外資及陸資(不含外資自營商)"
FOREIGN_SELF = "外資自營商"

def parse_iso(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()

def iter_dates(start: date, end: date):
    d = start
    while d <= end:
        if d.weekday() < 5:  # Mon-Fri
            yield d
        d += timedelta(days=1)

def fetch_one(d: date, retries: int = 3):
    url = f"{TWSE}?dayDate={d.strftime('%Y%m%d')}&type=day&response=json"
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "FxFlowTracker/1.0 (+github actions)"
    })
    last = None
    for i in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(1.0 * (i + 1))
    print(f"[warn] {d} fetch failed: {last}", file=sys.stderr)
    return None

def to_num(s) -> int:
    if s is None: return 0
    try:
        return int(str(s).replace(",", "").strip() or 0)
    except ValueError:
        return 0

def extract_rows(d: date, payload):
    if not payload or payload.get("stat") != "OK":
        return []
    by_name = {}
    for row in payload.get("data", []) or []:
        if not row: continue
        by_name[str(row[0]).strip()] = (to_num(row[1]), to_num(row[2]))
    fm_b, fm_s = by_name.get(FOREIGN_MAIN, (0, 0))
    fs_b, fs_s = by_name.get(FOREIGN_SELF, (0, 0))
    iso = d.strftime("%Y-%m-%d")
    return [
        {"date": iso, "name": "Foreign_Investor",    "buy": fm_b, "sell": fm_s},
        {"date": iso, "name": "Foreign_Dealer_Self", "buy": fs_b, "sell": fs_s},
    ]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--end",   required=True, help="YYYY-MM-DD")
    ap.add_argument("--out",   required=True)
    ap.add_argument("--sleep", type=float, default=0.35,
                    help="seconds between requests (be polite to TWSE)")
    args = ap.parse_args()

    start, end = parse_iso(args.start), parse_iso(args.end)
    rows = []
    n_ok = n_skip = 0
    for d in iter_dates(start, end):
        payload = fetch_one(d)
        got = extract_rows(d, payload)
        if got:
            rows.extend(got); n_ok += 1
        else:
            n_skip += 1
        time.sleep(args.sleep)

    rows.sort(key=lambda r: (r["date"], r["name"]))
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(
            {"msg": "success", "status": 200, "source": "twse", "data": rows},
            f, ensure_ascii=False, separators=(",", ":")
        )
    print(f"[ok] trading_days_written={n_ok}, skipped={n_skip}, rows={len(rows)}",
          file=sys.stderr)

if __name__ == "__main__":
    main()
