// Cloudflare Pages Function: /api/finmind
// -------------------------------------------------------------
// 路由策略：
// - TaiwanExchangeRate → FinMind（免費）
// - TaiwanStockPrice → FinMind（免費）
// - TaiwanStockInstitutionalInvestorsBuySell
// ① 若有 FINMIND_TOKEN env，優先使用 FinMind API（無行數上限）
// ② 否則使用 TWSE BFI82U 逐日抓取（每次請求上限 45 交易日）
//    前端已改為月份分批請求，可覆蓋 12 個月以上
// ③ TWSE 全失敗 / 空 → fallback 讀 /data/foreign_flow.json
// 輸出格式偽裝成 FinMind: { msg, status, data:[{date,name,buy,sell}, ...] }
// -------------------------------------------------------------

const FINMIND_UPSTREAM = "https://api.finmindtrade.com/api/v4/data";
const TWSE_BFI82U = "https://www.twse.com.tw/rwd/zh/fund/BFI82U";

const ALLOWED_DATASETS = new Set([
  "TaiwanExchangeRate",
  "TaiwanStockInstitutionalInvestorsBuySell",
  "TaiwanStockPrice"
]);

// TWSE 中文欄位名（依官方回傳 row[0]）
const TW_FOREIGN_MAIN = "外資及陸資(不含外資自營商)";
const TW_FOREIGN_SELF = "外資自營商";

// 抓取參數
const TWSE_CONCURRENCY = 4; // 同時打 TWSE 的併發數
const TWSE_MAX_DAYS = 400;  // 防呆，單次查詢上限

// ============================================================

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);
  const dataset = params.get("dataset");

  if (!dataset || !ALLOWED_DATASETS.has(dataset)) {
    return jsonResponse({ status: 400, msg: "dataset not allowed" }, 400);
  }

  // ===== 三大法人：依 token 決定資料來源 =====
  if (dataset === "TaiwanStockInstitutionalInvestorsBuySell") {
    const start = params.get("start_date");
    const end   = params.get("end_date");
    if (!start || !end) {
      return jsonResponse({ status: 400, msg: "missing start_date / end_date" }, 400);
    }

    // ① 若有 FinMind token，優先使用 FinMind API（無行數限制，支援任意長區間）
    if (env.FINMIND_TOKEN) {
      try {
        const fmParams = new URLSearchParams({
          dataset: "TaiwanStockInstitutionalInvestorsBuySell",
          start_date: start,
          end_date: end,
          token: env.FINMIND_TOKEN
        });
        const fmRes = await fetch(FINMIND_UPSTREAM + "?" + fmParams.toString(), {
          headers: { "Accept": "application/json" },
          cf: { cacheTtl: 300, cacheEverything: true }
        });
        if (fmRes.ok) {
          const fmJson = await fmRes.json();
          if (Array.isArray(fmJson?.data) && fmJson.data.length > 0) {
            const data = fmJson.data
              .filter(r => r.name === "Foreign_Investor" || r.name === "Foreign_Dealer_Self")
              .map(r => ({
                date: r.date,
                name: r.name,
                buy: Number(r.buy) || 0,
                sell: Number(r.sell) || 0
              }));
            return jsonResponse(
              { msg: "success", status: 200, source: "finmind", data },
              200, 300
            );
          }
        }
      } catch (err) {
        console.error("FinMind FINI fetch error:", err && err.message);
      }
    }

    // ② 無 token：TWSE BFI82U 逐日抓取
    // 注意：TWSE 每次請求約 45 交易日上限；前端已改為月份分批，每次 ≤31 天
    let twseRows = [];
    let twseErr  = null;
    try {
      twseRows = await fetchTwseRange(start, end);
    } catch (err) {
      twseErr = err;
      console.error("TWSE fetch error:", err && err.message);
    }
    if (twseRows.length > 0) {
      return jsonResponse(
        { msg: "success", status: 200, source: "twse", data: twseRows },
        200, 300
      );
    }

    // ③ Fallback：讀靜態快取 /data/foreign_flow.json
    try {
      const origin = url.origin;
      const r = await fetch(`${origin}/data/foreign_flow.json`, {
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      if (r.ok) {
        const j = await r.json();
        const data = (j.data || []).filter(x => x.date >= start && x.date <= end);
        if (data.length > 0) {
          return jsonResponse(
            { msg: "success(cache)", status: 200, source: "cache", data },
            200, 300
          );
        }
      }
    } catch (e) {
      console.error("Cache fallback error:", e && e.message);
    }

    return jsonResponse({
      status: 502,
      msg: "all data sources failed" + (twseErr ? `: ${twseErr.message}` : "")
    }, 502);
  }

  // ===== 其他 dataset：原樣代理 FinMind =====
  params.delete("token");
  if (env.FINMIND_TOKEN) params.append("token", env.FINMIND_TOKEN);
  const upstreamUrl = FINMIND_UPSTREAM + "?" + params.toString();

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

// ===================== TWSE helpers =====================

async function fetchTwseRange(startISO, endISO) {
  const days = enumerateDates(startISO, endISO);
  const out  = [];
  for (let i = 0; i < days.length; i += TWSE_CONCURRENCY) {
    const slice   = days.slice(i, i + TWSE_CONCURRENCY);
    const results = await Promise.all(
      slice.map(d => fetchTwseOneDay(d).catch(err => {
        console.error(`TWSE ${d} failed:`, err && err.message);
        return [];
      }))
    );
    for (const arr of results) if (arr && arr.length) out.push(...arr);
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

async function fetchTwseOneDay(isoDate) {
  const d   = new Date(isoDate + "T00:00:00Z");
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return [];

  const yyyymmdd = isoDate.replaceAll("-", "");
  const u = `${TWSE_BFI82U}?dayDate=${yyyymmdd}&type=day&response=json`;
  const res = await fetch(u, {
    headers: { "Accept": "application/json", "User-Agent": "FxFlowTracker/1.0" },
    cf: { cacheTtl: 86400, cacheEverything: true }
  });
  if (!res.ok) return [];
  let j;
  try { j = await res.json(); } catch { return []; }
  if (j.stat !== "OK" || !Array.isArray(j.data)) return [];

  const map = {};
  for (const row of j.data) {
    map[String(row[0] || "").trim()] = {
      buy:  parseTwseNum(row[1]),
      sell: parseTwseNum(row[2])
    };
  }
  const fm = map[TW_FOREIGN_MAIN] || { buy: 0, sell: 0 };
  const fs = map[TW_FOREIGN_SELF] || { buy: 0, sell: 0 };

  return [
    { date: isoDate, name: "Foreign_Investor",    buy: fm.buy, sell: fm.sell },
    { date: isoDate, name: "Foreign_Dealer_Self", buy: fs.buy, sell: fs.sell }
  ];
}

function parseTwseNum(s) {
  if (s == null) return 0;
  const n = Number(String(s).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function enumerateDates(startISO, endISO) {
  const out = [];
  const s   = new Date(startISO + "T00:00:00Z");
  const e   = new Date(endISO   + "T00:00:00Z");
  if (isNaN(s) || isNaN(e) || s > e) return out;
  let cnt = 0;
  for (let d = new Date(s); d <= e && cnt < TWSE_MAX_DAYS;
       d.setUTCDate(d.getUTCDate() + 1), cnt++) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ===================== misc =====================

function jsonResponse(obj, status, cacheSec) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type":              "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cacheSec ? `public, max-age=${cacheSec}` : "no-store"
    }
  });
}
