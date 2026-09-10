#!/usr/bin/env python3
"""
Generates a static, SEO-friendly HTML page listing the most volatile
tariff codes — real content baked into the HTML at sync time, not
rendered client-side, so search engines see it without running JS.

Reads data.json (already produced by sync_data.py) and writes
volatile.html to the repo root, where Netlify serves it as a normal
static page alongside index.html.
"""
import json
import datetime

DATA_PATH = "data.json"
OUTPUT_PATH = "volatile.html"
WEEK_WINDOW_DAYS = 7
MIN_ITEMS_FOR_WEEK_VIEW = 5


def load_data():
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def changed_items(data):
    items = [
        i for i in data["items"]
        if i.get("priorRate") is not None and i["priorRate"] != i["rate"]
    ]
    for i in items:
        i["_delta"] = abs(i["rate"] - i["priorRate"])
    items.sort(key=lambda i: i["_delta"], reverse=True)
    return items


def within_last_week(item):
    date_str = item.get("changeDate") or item.get("effectiveDate")
    if not date_str:
        return False
    try:
        d = datetime.date.fromisoformat(date_str)
    except ValueError:
        return False
    return (datetime.date.today() - d).days <= WEEK_WINDOW_DAYS


def render_row(item):
    direction = "US &rarr; CA" if item["direction"] == "us_to_ca" else "CA &rarr; US"
    arrow = "&#9650;" if item["rate"] > item["priorRate"] else "&#9660;"
    color = "#B5472F" if item["rate"] > item["priorRate"] else "#2E6B4F"
    return f"""
    <tr>
      <td><code>{item['hs']}</code></td>
      <td>{item['desc']}</td>
      <td>{item['category']}</td>
      <td>{direction}</td>
      <td style="color:{color};font-weight:600;">{arrow} {item['priorRate']}% &rarr; {item['rate']}%</td>
    </tr>"""


def build_html(data):
    all_changed = changed_items(data)
    this_week = [i for i in all_changed if within_last_week(i)]

    if len(this_week) >= MIN_ITEMS_FOR_WEEK_VIEW:
        shown = this_week
        heading = "Most Volatile Tariff Codes This Week"
        intro = (
            f"HS codes with the largest rate changes recorded in the last "
            f"{WEEK_WINDOW_DAYS} days, tracked automatically by Tariff Watch."
        )
    else:
        shown = all_changed
        heading = "Tracked Tariff Rate Changes"
        intro = (
            "All HS codes with a recorded rate change so far. Tariff Watch "
            "began tracking history on 2026-09-08 — this list will narrow "
            "to a genuine weekly view as more changes are recorded."
        )

    rows = "".join(render_row(i) for i in shown[:50]) if shown else ""
    empty_note = "<p>No rate changes have been recorded yet.</p>" if not shown else ""
    updated = data.get("dataLastSynced", "")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{heading} — Tariff Watch</title>
<meta name="description" content="{intro}">
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 900px; margin: 0 auto; padding: 32px 20px; line-height: 1.6; color: #212B36; }}
  h1 {{ font-size: 26px; margin-bottom: 4px; }}
  .updated {{ color: #666; font-size: 13px; margin-bottom: 20px; }}
  p.intro {{ color: #444; max-width: 640px; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 14px; }}
  th, td {{ text-align: left; padding: 8px 10px; border-bottom: 1px solid #E0DAC5; }}
  th {{ background: #EBE6D6; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }}
  code {{ font-family: ui-monospace, "SF Mono", monospace; }}
  .cta {{ margin-top: 28px; padding: 16px; background: #EBE6D6; border-radius: 8px; }}
  a {{ color: #223349; }}
</style>
</head>
<body>

<h1>{heading}</h1>
<p class="updated">Data as of {updated} &middot; Updated daily</p>
<p class="intro">{intro}</p>

{empty_note}
<table>
<thead><tr><th>HS Code</th><th>Description</th><th>Category</th><th>Direction</th><th>Change</th></tr></thead>
<tbody>{rows}</tbody>
</table>

<div class="cta">
  <strong>Track your own tariff exposure.</strong>
  <a href="/">Open Tariff Watch</a> to build a watchlist, get alerts when
  rates change, and generate landed-cost reports.
</div>

</body>
</html>
"""


def main():
    data = load_data()
    html = build_html(data)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
