// Cloudflare Pages Function: /api/finmind
// Proxies requests to FinMind, injecting the API token from env (FINMIND_TOKEN).
// Token never reaches the browser.

const UPSTREAM = "https://api.finmindtrade.com/api/v4/data";
// Allow only known datasets to prevent the proxy being abused as an open relay.
const ALLOWED_DATASETS = new Set([
  "TaiwanExchangeRate",
  "TaiwanStockInstitutionalInvestorsBuySell",
  "TaiwanStockPrice"
]);

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);

  const dataset = params.get("dataset");
  if (!dataset || !ALLOWED_DATASETS.has(dataset)) {
    return jsonResponse({ status: 400, msg: "dataset not allowed" }, 400);
  }

  // Strip any client-supplied token; always use the server-side one.
  params.delete("token");
  if (env.FINMIND_TOKEN) {
    params.append("token", env.FINMIND_TOKEN);
  }

  const upstreamUrl = UPSTREAM + "?" + params.toString();

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: "GET",
      headers: { "Accept": "application/json" },
      cf: { cacheTtl: 60, cacheEverything: true }
    });
  } catch (err) {
    return jsonResponse({ status: 502, msg: "upstream fetch failed: " + (err && err.message) }, 502);
  }

  const text = await upstreamRes.text();
  return new Response(text, {
    status: upstreamRes.status,
    headers: {
      "Content-Type": upstreamRes.headers.get("Content-Type") || "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    }
  });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
