// GET /.netlify/functions/fetch-canada-tariffs
// Fetches the Finance Canada counter-tariff page FROM NETLIFY'S OWN
// NETWORK (AWS Lambda) and relays the raw HTML back as plain text.
//
// Why this exists: GitHub Actions runners (Azure IP ranges) were
// timing out on every attempt to reach canada.ca — including its plain
// homepage — while the same requests work fine from other networks.
// That points to network-level throttling of the Actions IP range
// specifically, not anything about headers or the target page. Routing
// the fetch through Netlify's network is a cheap experiment to see if
// a different cloud provider's IPs fare better. All the actual HTML
// parsing still happens in scripts/sync_data.py — this function's only
// job is "fetch this URL from a different network and hand back the
// bytes."
//
// Protected by the same shared secret as notify.mjs so this can't be
// used as an open fetch-anything proxy by a random caller.
export default async (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const providedSecret = req.headers.get("x-notify-secret");
  if (!process.env.NOTIFY_SECRET || providedSecret !== process.env.NOTIFY_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const targetUrl =
    "https://www.canada.ca/en/department-finance/programs/international-trade-finance-policy/canadas-response-us-tariffs/complete-list-us-products-subject-to-counter-tariffs.html";

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-CA,en;q=0.9",
      },
      // Netlify Functions have their own platform-level execution time
      // limit; this AbortSignal just makes sure we fail fast and
      // predictably rather than hanging past that limit uninformatively.
      signal: AbortSignal.timeout(25000),
    });

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: `Upstream returned ${upstream.status}` }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const html = await upstream.text();
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
};
