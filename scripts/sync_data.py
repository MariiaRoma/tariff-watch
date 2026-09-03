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
import os
import re
import sys
import time
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

# Optional relay: if CANADA_PROXY_URL and NOTIFY_SECRET are set as
# environment variables, fetch the Finance Canada page through the
# fetch-canada-tariffs Netlify Function instead of directly. This exists
# because GitHub Actions' own network (Azure IP ranges) was observed
# timing out on canada.ca entirely — including its plain homepage —
# while other networks may not be. When unset, this script falls back
# to fetching canada.ca directly, same as before.
CANADA_PROXY_URL = os.environ.get("CANADA_PROXY_URL", "").strip()
NOTIFY_SECRET_FOR_PROXY = os.environ.get("NOTIFY_SECRET", "").strip()

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
REQUEST_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-CA,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
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


def _fetch_html_via_proxy():
    """Ask the fetch-canada-tariffs Netlify Function to fetch the page
    from its own network and hand back the raw HTML. Returns the HTML
    text, or None if the proxy isn't configured or the call failed.
    """
    if not CANADA_PROXY_URL or not NOTIFY_SECRET_FOR_PROXY:
        return None
    try:
        resp = requests.get(
            CANADA_PROXY_URL,
            headers={"X-Notify-Secret": NOTIFY_SECRET_FOR_PROXY},
            timeout=40,
        )
        if not resp.ok:
            log(f"  (proxy fetch failed: HTTP {resp.status_code} — body: {resp.text[:500]})")
            return None
        log(f"Fetched Finance Canada page via Netlify proxy ({len(resp.text)} bytes).")
        return resp.text
    except Exception as e:
        log(f"  (proxy fetch failed: {e} — falling back to a direct request)")
        return None


def _fetch_html_direct():
    """Fetch the page directly from this machine's own network, with a
    session warm-up and two attempts. Returns the HTML text, or None.
    """
    last_error = None
    for attempt in (1, 2):
        try:
            session = requests.Session()
            session.headers.update(REQUEST_HEADERS)
            # Warm up like a real visitor would: land on the homepage first
            # (gets real cookies set), then navigate to the target page
            # with a same-site Referer, rather than a single cold direct
            # hit — some government WAFs treat a referrer-less deep-link
            # from a fresh connection as bot-like and throttle it.
            session.get("https://www.canada.ca/en.html", timeout=30)
            candidate = session.get(
                FINANCE_CANADA_URL,
                headers={"Referer": "https://www.canada.ca/en.html"},
                timeout=60,
            )
            candidate.raise_for_status()
            return candidate.text
        except Exception as e:
            last_error = e
            log(f"  (attempt {attempt}/2 to fetch Finance Canada page directly failed: {e})")
            if attempt == 1:
                time.sleep(5)
    log(f"WARNING: could not fetch Finance Canada page after 2 direct attempts ({last_error}).")
    return None


def fetch_finance_canada_table():
    """Fetch and parse the official counter-tariff list by hand: fetch the
    raw HTML (via the Netlify proxy if configured, otherwise directly),
    use BeautifulSoup to find every <table> element on the page, and
    parse each one individually. No API, no JSON endpoint — just HTML.

    Returns a list of dicts with keys: hs, desc, rate. Returns None (not
    an empty list) on any failure, so the caller can distinguish "fetched
    zero relevant rows" from "couldn't fetch at all" and avoid wiping out
    good data because of a transient network error.
    """
    html = _fetch_html_via_proxy()
    if html is None:
        html = _fetch_html_direct()
    if html is None:
        log("Keeping existing us_to_ca data.")
        return None

    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception as e:
        log(f"WARNING: could not parse the page HTML ({e}). Keeping existing us_to_ca data.")
        return None

    table_tags = soup.find_all("table")
    if not table_tags:
        log("WARNING: no <table> elements found on the page — the page layout may have changed. Keeping existing us_to_ca data.")
        return None
    log(f"Found {len(table_tags)} <table> element(s) on the page.")

    import io as io_module
    import pandas as pd

    rows = []
    hs_pattern = re.compile(r"^\d{4}\.\d{2}\.\d{2}$")

    for table_tag in table_tags:
        try:
            # Wrap in StringIO: passing a raw string directly can make
            # pandas' lxml backend misinterpret it as a file path rather
            # than literal markup, raising a spurious FileNotFoundError.
            parsed = pd.read_html(io_module.StringIO(str(table_tag)))
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
        log(f"WARNING: could not fetch USITC
