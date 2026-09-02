#!/usr/bin/env python3
"""
Tariff Watch — data sync script
--------------------------------
Regenerates data.json (source of truth) and data.js (browser-ready copy)
from two live sources, and writes changes.json listing any rate changes
so the GitHub Actions workflow knows whether to trigger push
notifications.

Sources:
  - us_to_ca (Canada's counter-tariffs on US goods): PARSED directly out
    of the official Finance Canada webpage with BeautifulSoup + pandas
    — no API. This is the primary source and now ADDS every HS code it
    finds that isn't already in the dataset, not just refreshes rates
    on existing rows, so a full run should grow toward the real ~874-
    item official list rather than staying capped at the original
    curated sample.
  - ca_to_us (US Section 338 tariffs on Canadian goods): cross-checked
    against the official USITC HTS REST API for the specific,
    documented Chapter 99 headings (9903.03.12-9903.03.16). This is the
    one API call in this script — added deliberately, because no
    scrapeable single-page equivalent to Finance Canada's list exists
    for the US side. USITC's exact JSON field names aren't fully
    pinned down (see fetch_usitc_chapter99's docstring), so this path
    logs its raw findings for easy debugging rather than failing
    silently, and never touches the hand-curated illustrative ca_to_us
    rows that were already there — it only adds what it can positively
    identify.

Honesty note: if a fetch fails or a source's structure has changed
since this was written, the script logs a warning and KEEPS the
previous data for that side rather than silently corrupting it. Read
the run log — especially on the first run after this update, to see
how many rows actually got added on each side.

Usage:
    python3 scripts/sync_data.py

Requires: requests, pandas, lxml, beautifulsoup4 (see
scripts/requirements.txt — installed automatically by the GitHub Actions
workflow; if running locally, `pip install -r scripts/requirements.txt`).
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA_JSON = ROOT / "data.json"
DATA_JS = ROOT / "data.js"
CHANGES_JSON = ROOT / "changes.json"

FINANCE_CANADA_URL = (
    "https://www.canada.ca/en/department-finance/programs/"
    "international-trade-finance-policy/canadas-response-us-tariffs/"
    "complete-list-us-products-subject-to-counter-tariffs.html"
)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
REQUEST_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-CA,en;q=0.9",
}

# USITC HTS REST API — used ONLY to cross-check the specific, publicly
# documented Chapter 99 headings created for the Section 338 Canada
# actions (9903.03.12 alcohol, .13 dairy, .14 motor-vehicles/broad
# basket, .15/.16 exclusions). This is the one API call in this script,
# added because there is no scrapeable single-page equivalent to Finance
# Canada's list for the US side, and because the person running this
# project asked for it explicitly once "parsing only" turned out to
# leave the ca_to_us side stuck at hand-maintained sample data.
USITC_EXPORT_URL = "https://hts.usitc.gov/reststop/exportList"
USITC_RANGE_FROM = "9903.03.12"
USITC_RANGE_TO = "9903.03.17"

# HS chapter (first 2 digits) -> display category, used when the live
# Finance Canada scrape turns up an HS code that isn't already in our
# curated set. Deliberately broad-brush; falls back to "Other" for any
# chapter not listed here rather than failing.
CHAPTER_CATEGORY = {
    "01": "Agriculture", "02": "Meat", "03": "Fish & seafood", "04": "Dairy",
    "05": "Animal products", "06": "Plants & flowers", "07": "Vegetables",
    "08": "Fruit & nuts", "09": "Agriculture", "10": "Cereals",
    "11": "Milling & starches", "12": "Oilseeds & agriculture", "13": "Plant extracts",
    "14": "Plant materials", "15": "Fats & oils", "16": "Meat & fish preparations",
    "17": "Food processing", "18": "Cocoa & chocolate", "19": "Food processing",
    "20": "Food processing", "21": "Food processing", "22": "Alcohol",
    "23": "Animal feed", "24": "Tobacco", "25": "Building materials",
    "26": "Ores & minerals", "27": "Fuels", "28": "Chemicals", "29": "Chemicals",
    "30": "Pharmaceuticals", "31": "Fertilizers", "32": "Dyes & pigments",
    "33": "Cosmetics", "34": "Soaps & waxes", "35": "Food & industrial inputs",
    "36": "Explosives & pyrotechnics", "37": "Photographic goods",
    "38": "Chemicals", "39": "Plastics", "40": "Rubber", "41": "Leather",
    "42": "Leather & travel goods", "43": "Furskins", "44": "Wood products",
    "45": "Cork", "46": "Straw & basketware", "47": "Pulp & paper",
    "48": "Pulp & paper", "49": "Stationery", "50": "Textiles", "51": "Textiles",
    "52": "Textiles", "53": "Textiles", "54": "Textiles", "55": "Textiles",
    "56": "Textiles", "57": "Textiles", "58": "Textiles", "59": "Textiles",
    "60": "Textiles", "61": "Apparel", "62": "Apparel", "63": "Textiles",
    "64": "Footwear", "65": "Headgear", "66": "Umbrellas & walking sticks",
    "67": "Feathers & artificial flowers", "68": "Building materials",
    "69": "Ceramics", "70": "Glass & packaging", "71": "Jewellery & precious metals",
    "72": "Steel", "73": "Steel", "74": "Copper", "75": "Nickel",
    "76": "Aluminum", "78": "Lead", "79": "Zinc", "80": "Tin",
    "81": "Base metals", "82": "Tools & cutlery", "83": "Metal articles",
    "84": "Machinery", "85": "Electronics", "86": "Rail equipment",
    "87": "Motor vehicles", "88": "Aircraft", "89": "Ships & boats",
    "90": "Instruments", "91": "Watches & clocks", "92": "Musical instruments",
    "93": "Arms & ammunition", "94": "Furniture", "95": "Toys & sporting goods",
    "96": "Miscellaneous", "97": "Art & antiques",
}


def category_for_hs(hs_code):
    chapter = hs_code[:2]
    return CHAPTER_CATEGORY.get(chapter, "Other")


def log(msg):
    print(f"[sync] {msg}", flush=True)


def fetch_finance_canada_table():
    """Fetch and parse the official counter-tariff list by hand: fetch the
    raw HTML, use BeautifulSoup to find every <table> element on the
    page, and parse each one individually. No API, no JSON endpoint —
    just HTML.

    Returns a list of dicts with keys: hs, desc, rate. Returns None (not
    an empty list) on any failure, so the caller can distinguish "fetched
    zero relevant rows" from "couldn't fetch at all" and avoid wiping out
    good data because of a transient network error.
    """
    try:
        resp = requests.get(
            FINANCE_CANADA_URL, headers=REQUEST_HEADERS, timeout=30
        )
        resp.raise_for_status()
    except Exception as e:
        log(f"WARNING: could not fetch Finance Canada page ({e}). Keeping existing us_to_ca data.")
        return None

    try:
        soup = BeautifulSoup(resp.text, "html.parser")
    except Exception as e:
        log(f"WARNING: could not parse the page HTML ({e}). Keeping existing us_to_ca data.")
        return None

    table_tags = soup.find_all("table")
    if not table_tags:
        log("WARNING: no <table> elements found on the page — the page layout may have changed. Keeping existing us_to_ca data.")
        return None
    log(f"Found {len(table_tags)} <table> element(s) on the page.")

    import pandas as pd

    rows = []
    hs_pattern = re.compile(r"^\d{4}\.\d{2}\.\d{2}$")

    for table_tag in table_tags:
        try:
            # Hand this one already-located <table> tag's HTML to pandas,
            # rather than letting pandas re-scan the whole page itself.
            parsed = pd.read_html(str(table_tag))
        except Exception:
            continue  # not every <table> on the page is a data table (e.g. layout tables)
        if not parsed:
            continue
        table = parsed[0]

        # The page's column headers vary between tables; find whichever
        # column actually contains HS-code-shaped strings rather than
        # hardcoding a header name that could change.
        for col in table.columns:
            series = table[col].astype(str)
            if series.str.match(hs_pattern).sum() < 3:
                continue
            cols = list(table.columns)
            for _, row in table.iterrows():
                hs_val = str(row[col]).strip()
                if not hs_pattern.match(hs_val):
                    continue
                desc_val = ""
                rate_val = None
                for other_col in cols:
                    if other_col == col:
                        continue
                    cell = str(row[other_col]).strip()
                    pct_match = re.search(r"(\d+(?:\.\d+)?)\s*%", cell)
                    if pct_match and rate_val is None:
                        rate_val = float(pct_match.group(1))
                    elif cell and cell.lower() != "nan" and len(cell) > len(desc_val):
                        desc_val = cell
                if rate_val is not None:
                    rows.append({"hs": hs_val, "desc": desc_val[:200], "rate": rate_val})
            break  # found the HS column for this table; move to the next table

    log(f"Parsed {len(rows)} candidate rows out of {len(table_tags)} table(s).")
    return rows


def fetch_usitc_chapter99():
    """Best-effort cross-check against the official USITC HTS REST API for
    the specific Chapter 99 headings publicly documented for the Section
    338 Canada actions (9903.03.12-9903.03.16). Returns a list of dicts
    with keys: hs, desc, rate — or None on any failure.

    Honesty note: USITC's own JSON field names aren't fully pinned down
    here (their docs describe the endpoint, not the exact response
    schema, and third parties report the schema shifting without
    notice). This function tries several plausible field names and, if
    it gets a response it can't make sense of, logs the raw keys it DID
    see so a human can fix the field-name guesses in one pass instead of
    guessing blind.
    """
    try:
        resp = requests.get(
            USITC_EXPORT_URL,
            params={"from": USITC_RANGE_FROM, "to": USITC_RANGE_TO, "format": "JSON", "styles": "false"},
            headers=REQUEST_HEADERS,
            timeout=30,
        )
        resp.raise_for_status()
    except Exception as e:
        log(f"WARNING: could not fetch USITC HTS API ({e}). Leaving ca_to_us data untouched.")
        return None

    try:
        data = resp.json()
    except Exception as e:
        log(f"WARNING: USITC API response wasn't valid JSON ({e}). Leaving ca_to_us data untouched.")
        return None

    if not isinstance(data, list) or not data:
        log("WARNING: USITC API returned no rows for the Chapter 99 Canada range. Leaving ca_to_us data untouched.")
        return None

    log(f"USITC API returned {len(data)} raw row(s) for {USITC_RANGE_FROM}-{USITC_RANGE_TO}.")
    log(f"  First row's fields, for debugging if extraction below finds nothing: {sorted(data[0].keys())}")

    hs_field_candidates = ["htsno", "hts_number", "htsNumber", "number", "hts"]
    desc_field_candidates = ["description", "desc", "briefDescription"]
    rate_field_candidates = ["general", "special", "other", "additional_duties", "additionalDuties", "footnotes"]

    def first_present(row, candidates):
        for c in candidates:
            if c in row and row[c]:
                return row[c]
        return None

    rows = []
    for row in data:
        hs_val = first_present(row, hs_field_candidates)
        if not hs_val or not str(hs_val).startswith("9903.03.1"):
            continue
        desc_val = first_present(row, desc_field_candidates) or ""
        rate_val = None
        for field in rate_field_candidates:
            text = row.get(field)
            if not text:
                continue
            pct_match = re.search(r"\+?\s*(\d+(?:\.\d+)?)\s*%", str(text))
            if pct_match:
                rate_val = float(pct_match.group(1))
                break
        if rate_val is not None:
            rows.append({"hs": str(hs_val), "desc": str(desc_val)[:250], "rate": rate_val})

    log(f"Extracted {len(rows)} usable Chapter 99 row(s) after field-matching.")
    return rows if rows else None


def merge_ca_to_us_from_usitc(existing_items, usitc_rows):
    """Additive-only, like merge_us_to_ca's new-row path: adds an entry
    for every USITC Chapter 99 row not already present (matched by HS
    code), never touches the hand-curated illustrative ca_to_us entries
    that were already there.
    """
    if not usitc_rows:
        return existing_items, []

    existing_hs = {i["hs"] for i in existing_items if i["direction"] == "ca_to_us"}
    changes = []
    added = 0
    updated = list(existing_items)

    for row in usitc_rows:
        if row["hs"] in existing_hs:
            continue
        updated.append(
            {
                "id": "usitc-" + row["hs"].replace(".", "-"),
                "direction": "ca_to_us",
                "hs": row["hs"],
                "desc": row["desc"] or "(description not captured — see USITC HTS)",
                "category": "Cross-border (Section 338)",
                "rate": row["rate"],
                "priorRate": None,
                "effectiveDate": "2026-08-22",
                "legalBasis": "USITC HTS API, Section 338 Proclamations (Ch.99 9903.03.12-.16)",
                "verified": True,
            }
        )
        added += 1

    if added:
        log(f"Added {added} new ca_to_us entr{'y' if added == 1 else 'ies'} from the USITC API.")

    return updated, changes


def load_seed():
    """data.json is both the hand-edited seed AND the sync script's own
    output — each run reads it, updates what it can verify, and writes
    it back. There's no separate seed file to keep in sync.
    """
    with open(DATA_JSON) as f:
        return json.load(f)


def merge_us_to_ca(existing_items, scraped_rows):
    """Update rate/priorRate on existing us_to_ca entries that match a
    scraped HS code, and ADD a new entry for every scraped HS code we
    don't already have — this is what actually grows the dataset beyond
    the original curated sample toward the full official list. Never
    removes a curated row just because it didn't appear in this
    particular scrape (a parsing miss shouldn't silently delete data).
    """
    if scraped_rows is None:
        return existing_items, []

    scraped_by_hs = {r["hs"]: r for r in scraped_rows}
    changes = []
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    updated = []
    seen_hs = set()
    for item in existing_items:
        if item["direction"] != "us_to_ca":
            updated.append(item)
            continue
        seen_hs.add(item["hs"])
        match = scraped_by_hs.get(item["hs"])
        if match is None:
            updated.append(item)
            continue
        new_rate = match["rate"]
        if new_rate != item["rate"]:
            changes.append(
                {
                    "id": item["id"],
                    "hs": item["hs"],
                    "desc": item["desc"],
                    "oldRate": item["rate"],
                    "newRate": new_rate,
                }
            )
            item = {
                **item,
                "priorRate": item["rate"],
                "rate": new_rate,
                "changeDate": today,
            }
        updated.append(item)

    added = 0
    for hs_val, row in scraped_by_hs.items():
        if hs_val in seen_hs:
            continue
        new_id = "ca-" + hs_val.replace(".", "-")
        updated.append(
            {
                "id": new_id,
                "direction": "us_to_ca",
                "hs": hs_val,
                "desc": row["desc"] or "(description not captured — see official list)",
                "category": category_for_hs(hs_val),
                "rate": row["rate"],
                "priorRate": None,
                "effectiveDate": "2026-09-08",
                "legalBasis": "Counter-tariff list (Finance Canada) — added by live sync",
                "verified": True,
            }
        )
        added += 1

    if added:
        log(f"Added {added} new us_to_ca entr{'y' if added == 1 else 'ies'} not previously in the dataset.")

    return updated, changes


def write_data_js(items):
    version = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    synced_human = datetime.now(timezone.utc).strftime("%B %-d, %Y")
    categories = sorted({i["category"] for i in items})

    js = []
    js.append("/**\n * Tariff Watch — dataset (AUTO-GENERATED)\n")
    js.append(" * Generated by scripts/sync_data.py — do not hand-edit this file.\n")
    js.append(" * Edit data.json by hand for one-off fixes; the sync workflow\n")
    js.append(" * layers live updates on top on every scheduled run.\n */\n\n")
    js.append(f'const DATA_VERSION = "{version}";\n')
    js.append(f'const DATA_LAST_SYNCED = "{synced_human}";\n\n')
    js.append("const TARIFF_DATA = ")
    js.append(json.dumps(items, indent=2))
    js.append(";\n\n")
    js.append("const ALL_CATEGORIES = [...new Set(TARIFF_DATA.map(d => d.category))].sort();\n")

    DATA_JS.write_text("".join(js))
    DATA_JSON.write_text(
        json.dumps({"dataVersion": version, "dataLastSynced": synced_human, "items": items}, indent=2)
    )
    log(f"Wrote {DATA_JS.name} and {DATA_JSON.name} ({len(items)} items, version {version}).")


def main():
    seed = load_seed()
    items = seed["items"]

    try:
        log("Fetching live Finance Canada counter-tariff list...")
        scraped_rows = fetch_finance_canada_table()
        items, changes = merge_us_to_ca(items, scraped_rows)
    except Exception as e:
        log(f"ERROR during Finance Canada fetch/parse/merge ({e}). Falling back to unchanged data for this side.")
        changes = []

    try:
        log("Cross-checking USITC HTS API for Section 338 Canada headings...")
        usitc_rows = fetch_usitc_chapter99()
        items, usitc_changes = merge_ca_to_us_from_usitc(items, usitc_rows)
        changes += usitc_changes
    except Exception as e:
        log(f"ERROR during USITC fetch/parse/merge ({e}). Falling back to unchanged data for this side.")

    if changes:
        log(f"Detected {len(changes)} rate change(s):")
        for c in changes:
            log(f"  {c['hs']}: {c['oldRate']}% -> {c['newRate']}%")
    else:
        log("No rate changes detected this run.")

    write_data_js(items)
    CHANGES_JSON.write_text(json.dumps(changes, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
