# Tariff Watch — MVP + live data sync + push notifications

A mobile-installable PWA that tracks Canada–US counter-tariff changes by HS
code: a **watchlist** with rate-change flags, an **HS search**, a
**landed-cost calculator** — now backed by a **daily Python data sync**
and **real Web Push notifications** when a watched code's rate changes.

## What's new since the static MVP

- `scripts/sync_data.py` — a Python script that fetches the official
  Finance Canada counter-tariff page and parses its HTML tables directly
  (BeautifulSoup + pandas — **no REST/JSON API involved by design**), and
  regenerates `data.js`/`data.json` with any rate changes it finds.
- `.github/workflows/sync-tariffs.yml` — runs that script every day,
  commits any changes back to the repo (which makes Netlify redeploy
  automatically), and calls the notify function if anything changed.
- `netlify/functions/` — three small serverless functions
  (`subscribe`, `unsubscribe`, `notify`) that store push subscriptions in
  Netlify Blobs (free, built into your existing Netlify account) and send
  real Web Push notifications via the `web-push` library.
- `app.js` / `service-worker.js` — a "Get notified" banner, the
  subscribe/unsubscribe flow, and a `push` handler that shows a real
  system notification.

None of this is optional plumbing you can skip — **push notifications
will not work until you complete the one-time setup below**, because it
needs secrets that can't ship inside a public repo.

## Quick start (local)

Same as before — no build step, just serve the folder:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Note: the sync script and push functions **cannot be meaningfully tested
locally** — they need a real Netlify deployment (for Functions + Blobs)
and a real GitHub repo (for the scheduled workflow). Deploy first, then
test.

## One-time setup, part 1: get the code onto GitHub + Netlify

If you already did this for the static MVP, you just need to **replace
the old files with this new version** in the same repo (drag the new zip
contents over the old ones via GitHub's "Add file → Upload files", same
as before — it overwrites files with matching names and adds the new
ones like `.github/`, `netlify/`, `scripts/`). Netlify will redeploy
automatically once you commit.

If this is your first time, follow the GitHub + Netlify steps from the
previous setup round (create a GitHub repo, upload these files to its
root, connect Netlify via "Import an existing project").

## One-time setup, part 2: turn on push notifications

This is the part that can't be skipped or automated — Netlify and GitHub
each need a couple of secret values that only you can enter, because
they're not safe to commit to a public repo.

### A real VAPID key pair has already been generated for you

VAPID keys are how a push service verifies which server is allowed to
send notifications to a given subscription. **Use these real,
already-generated keys** — don't regenerate them unless you have a
reason to (regenerating invalidates every existing subscription):

```
VAPID_PUBLIC_KEY  = BO9z5gD_cw7KvLftef79Mq9RhSBDQ6OuZM_-ZZ6EduhV732nc5W-_hILjk8Sy1fufeIduX2UvSLF7mobC7cxc_M
VAPID_PRIVATE_KEY = qHUcHXz3WWCLO9QLA1PvfFA2cFDEI4IqV25cKJ1Hu8E
```

The **public** key is already baked into `app.js` (it's meant to be
public — it's how the browser identifies your server, not a secret).
The **private** key must go ONLY into Netlify's environment variables
below — never into any file you commit.

### Step 1 — Add environment variables in Netlify

Netlify dashboard → your site → **Project configuration → Environment
variables** → add each of these:

| Key | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | `BO9z5gD_cw7KvLftef79Mq9RhSBDQ6OuZM_-ZZ6EduhV732nc5W-_hILjk8Sy1fufeIduX2UvSLF7mobC7cxc_M` |
| `VAPID_PRIVATE_KEY` | `qHUcHXz3WWCLO9QLA1PvfFA2cFDEI4IqV25cKJ1Hu8E` |
| `VAPID_SUBJECT` | `mailto:` + your real email address (push services sometimes contact this if something's wrong) |
| `NOTIFY_SECRET` | `f69f6f0eaf65edf0bf8beb591cd9d075209515ad0d54b1e9cb130281fab1f027` (a random value already generated for you — or make your own) |

After saving, trigger a new deploy (Netlify → **Deploys → Trigger
deploy → Deploy site**) so the Functions pick up the new variables —
env var changes don't apply to already-built functions.

### Step 2 — Add secrets in GitHub

Your GitHub repo → **Settings → Secrets and variables → Actions → New
repository secret** → add:

| Name | Value |
|---|---|
| `NOTIFY_URL` | `https://YOUR-SITE-NAME.netlify.app/.netlify/functions/notify` (use your actual Netlify site URL) |
| `NOTIFY_SECRET` | the exact same value you put in Netlify above |

### Step 3 — Test the whole pipeline end to end

1. Open your live site on your phone, add at least one code to your
   watchlist, and tap **Enable** on the "Get notified" banner. Grant the
   permission prompt.
2. From any computer with `curl`, send a fake change for the exact HS
   code you just watched (replace the placeholders):

   ```bash
   curl -X POST https://YOUR-SITE-NAME.netlify.app/.netlify/functions/notify \
     -H "Content-Type: application/json" \
     -H "X-Notify-Secret: YOUR_NOTIFY_SECRET" \
     -d '{"changes":[{"id":"ca-0402-10-20","hs":"0402.10.20","desc":"test","oldRate":25,"newRate":50}]}'
   ```

   (Swap `"id"` for whichever HS entry's id you actually watched — you
   can find ids by viewing `data.json` in your repo.)
3. You should get a real system notification on your phone within a few
   seconds. If you don't: check the Netlify Function logs (**Project →
   Logs → Functions → notify**) for the error.
4. To test the real end-to-end path (not a fake curl call): go to your
   repo's **Actions** tab → **Sync tariff data** → **Run workflow** to
   trigger the sync manually, and check its log — it'll tell you how many
   rows it parsed from the live Finance Canada page and whether it found
   any real changes.

## Honesty note on the live data sync

I could not fully test the live scrape from my own sandbox — the
sandbox's network allowlist doesn't include `canada.ca`, so every fetch
attempt there returns a network-level block rather than a real HTTP
response. **This is a sandbox limitation, not a sign the scraper is
broken** — GitHub Actions runners have full, unrestricted internet
access, so the real test is the first run there.

After you trigger the workflow manually (Step 3.4 above), open its log
and look for a line like:

```
[sync] Parsed 68 candidate rows out of 4 table(s).
```

If that number is 0, the page's HTML structure has likely changed since
this was written, and the table-detection heuristic in
`scripts/sync_data.py` needs adjusting — tell me the log output and I'll
fix the parser. If it's a healthy-looking number, the sync is working.

Scope reminder: only the `us_to_ca` side (Canada's counter-tariffs on US
goods) is live-synced right now, because Finance Canada's page is the
one clean, scrapeable, single-page table found so far. The `ca_to_us`
side (US tariffs on Canadian goods) has no equivalent official page to
parse and remains manually maintained — deliberately not filled in via
any API, per your instruction to keep this to Python parsing only.

## Project layout

```
index.html                    App shell: header, 4 screens, sheet, tab bar
styles.css                     Design tokens + component styles
app.js                         State, rendering, calculator, watchlist,
                                push-notification subscribe/unsubscribe flow
data.js / data.json             The dataset — data.json is the source of
                                truth, data.js is the browser-ready copy;
                                both are regenerated by the sync script
manifest.webmanifest            PWA metadata
service-worker.js               Offline cache + push/notificationclick handlers
icons/                          App icons

scripts/
  sync_data.py                 Fetches + parses the Finance Canada page,
                                regenerates data.js/data.json/changes.json
  requirements.txt              Python deps for the sync script

.github/workflows/
  sync-tariffs.yml              Daily scheduled sync + notify trigger

netlify/functions/
  _shared.mjs                  Shared helpers (subscription key hashing)
  subscribe.mjs                 Store/update a push subscription + watchlist
  unsubscribe.mjs                Remove a push subscription
  notify.mjs                    Send Web Push to subscribers of changed codes

package.json                   Declares @netlify/blobs + web-push for Functions
netlify.toml                    Netlify build config + cache headers
```

## About the data — read before you rely on this for a real shipment

- **`us_to_ca` entries** (Canada's counter-tariffs on US-origin goods):
  copied from the official Finance Canada list at seed time, and
  refreshed daily by `scripts/sync_data.py` parsing the live page. Real,
  sourced HS10 codes.
- **`ca_to_us` entries** (US Section 338 / 232 tariffs on Canadian-origin
  goods): illustrative, category-level, **not** live-synced — no clean
  official page has been found to parse yet. Each entry's `verified:
  false` flag and "Representative — verify code" label in the UI reflect
  this.

**Do not ship this dataset as-is into a product used to price real
shipments** without independent verification — see the in-app disclaimer
and `legalBasis` field on every entry.

## Path to further improvements

- Add a comparable live-parseable source for the `ca_to_us` side once one
  exists (a Federal Register notice page, a USTR page — something with a
  stable HTML table, kept to the same "parsing, not API" approach).
- Move from Netlify Blobs to a real Postgres store (Netlify now offers
  **Netlify Database**, built on Neon) if subscriber volume grows enough
  that simple key-value listing in `notify.mjs` becomes slow — Blobs is
  the right, free choice at MVP scale, but doesn't support queries.
- Tighten `subscribe.mjs`/`unsubscribe.mjs` with a proper origin check
  once this handles real user volume (currently anyone who knows the
  endpoint URL could technically post a subscription — low risk at MVP
  scale, worth hardening later).

## Legal note

Tariff Watch is **not** a licensed customs broker in Canada or the
United States, and nothing in the app is a binding classification or
ruling. Keep the in-app disclaimer intact, and keep pointing people at
CBSA / CBP / a licensed broker for anything they intend to act on.

## Known MVP limitations

- Watchlist still lives in `localStorage` — per-device, no accounts.
- No provincial/territorial sales tax in the Canada-side calculator —
  GST only, clearly labelled.
- MPF min/max caps in the US-side calculator are commonly published
  figures and are adjusted by CBP periodically — verify current caps
  before relying on them.
- Search is a client-side filter over the curated sample, not a real HS
  classification tool.
- `subscribe`/`unsubscribe` endpoints don't yet verify the request
  actually came from your own site (see "Path to further improvements").
