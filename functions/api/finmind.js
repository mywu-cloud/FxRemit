// Cloudflare Pages Function: /api/finmind
// -------------------------------------------------------------
// 路由策略：
// - TaiwanExchangeRate → 先讀每日靜態快取 data/usd_twd.json，
//   若快取完整覆蓋查詢區間則直接回傳（省 FinMind 額度）；
//   否則 fallback 即時呼叫 FinMind（免費）
// - TaiwanStockPrice → 先讀每日靜態快取 data/taiex.json，
//   規則同上；否則 fallback 即時呼叫 FinMind（免費）
// - TaiwanStockInstitutionalInvestorsBuySell
//   ① 若有 FINMIND_TOKEN env，優先使用 FinMind API
//      注意：FinMind 在「未帶 data_id」查詢此 dataset 時，實測會忽略
//      end_date，只回傳 start_date 當天的全市場個股資料。因此這裡會
//      檢查回傳結果的唯一日期數，若明顯少於請求區間應有的交易日數，
//      視為異常，不直接採用，改為 fall through 到 ② TWSE 逐日抓取。
//   ② 否則使用 TWSE BFI82U 逐日抓取（每次請求上限 45 交易日）
//      前端已改為月份分批請求，可覆蓋 12 個月以上
//   ③ TWSE 全失敗 / 空 → fallback 讀 /data/foreign_flow.json
//   ④ 若整段查詢區間完全查無資料（例如末端為假日／尚未公布），
//      往前逐日尋找最近一個有資料的交易日，而非直接回報失敗
//
// data/usd_twd.json、data/taiex.json、data/foreign_flow.json 均由
// .github/workflows/auto-update.yml 每日台灣時間 19:00 / 20:00 自動更新
// （近 365 天滾動範圍），因此絕大多數查詢都能命中靜態快取，不需要
// 每次都消耗 FinMind API 額度。
//
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
const TWSE_MAX_DAYS = 400; // 防呆，單次查詢上限
const TWSE_LOOKBACK_MAX_DAYS = 15; // 查無資料時，往前尋找最近有資料日期的上限天數

// FinMind 回傳異常偵測：請求區間內平日數量超過此門檻，
// 但回傳資料的唯一日期數 <= 1 時，視為 FinMind 忽略了 end_date
const FINMIND_ANOMALY_MIN_WEEKDAYS = 3;

// 每日自動更新的靜態快取設定：dataset -> { file, idField, expected }
// idField/expected 用來確認請求的 data_id 與快取內容一致（例如
// TaiwanExchangeRate 快取只涵蓋 USD，TaiwanStockPrice 快取只涵蓋 TAIEX）
const STATIC_CACHE_CONFIG = {
        TaiwanExchangeRate: { file: "/data/usd_twd.json", idField: "currency", expected: "USD" },
        TaiwanStockPrice: { file: "/data/taiex.json", idField: "stock_id", expected: "TAIEX" }
};

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
            const end = params.get("end_date");
            if (!start || !end) {
                        return jsonResponse({ status: 400, msg: "missing start_date / end_date" }, 400);
            }

          // ① 若有 FinMind token，優先嘗試使用 FinMind API
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

                                                      const uniqueDateCount = new Set(data.map(r => r.date)).size;
                                                                      const requestedWeekdays = countWeekdays(start, end);
                                                                      const looksTruncatedToSingleDay =
                                                                                          requestedWeekdays > FINMIND_ANOMALY_MIN_WEEKDAYS && uniqueDateCount <= 1;

                                                      if (data.length > 0 && !looksTruncatedToSingleDay) {
                                                                          return jsonResponse(
                                                                                { msg: "success", status: 200, source: "finmind", data },
                                                                                                200, 300
                                                                                              );
                                                      }
                                                                      console.error(
                                                                                          `FinMind FINI range anomaly: requested ${requestedWeekdays} weekdays (${start}~${end}) but got ${uniqueDateCount} unique date(s); falling back to TWSE`
                                                                                        );
                                                    }
                                    }
                      } catch (err) {
                                    console.error("FinMind FINI fetch error:", err && err.message);
                      }
          }

          // ② 無 token 或 FinMind 結果異常：TWSE BFI82U 逐日抓取
          // 注意：TWSE 每次請求約 45 交易日上限；前端已改為月份分批，每次 ≤31 天
          let twseRows = [];
            let twseErr = null;
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

          // ④ 指定區間完全查無資料（例如末端為假日／尚未公布）
          // 往前逐日尋找最近一個有資料的交易日，而非直接回報失敗
          try {
                      const fallbackRows = await findLatestTwseDay(end, TWSE_LOOKBACK_MAX_DAYS);
                      if (fallbackRows.length > 0) {
                                    return jsonResponse(
                                          { msg: "success(fallback-latest)", status: 200, source: "twse-fallback", data: fallbackRows },
                                                    200, 300
                                                  );
                      }
          } catch (err) {
                      console.error("TWSE lookback error:", err && err.message);
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
                                    // 快取內查不到該區間，改取快取中最新一筆資料作為最近可用日期
                        const sorted = (j.data || []).filter(x => x.date <= end).sort((a, b) => b.date.localeCompare(a.date));
                                    if (sorted.length > 0) {
                                                    const latestDate = sorted[0].date;
                                                    const latestRows = sorted.filter(x => x.date === latestDate);
                                                    return jsonResponse(
                                                          { msg: "success(cache-fallback-latest)", status: 200, source: "cache-fallback", data: latestRows },
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

  // ===== 匯率 / 加權指數：先嘗試每日靜態快取，省 FinMind 額度 =====
  if (STATIC_CACHE_CONFIG[dataset]) {
            const start = params.get("start_date");
            const end = params.get("end_date");
            const dataId = params.get("data_id");
            if (start && end) {
                        try {
                                      const cachedRows = await tryStaticCache(url.origin, dataset, start, end, dataId);
                                      if (cachedRows) {
                                                      return jsonResponse(
                                                            { msg: "success(cache)", status: 200, source: "static-cache", data: cachedRows },
                                                                        200, 300
                                                                      );
                                      }
                        } catch (err) {
                                      console.error(`Static cache read error (${dataset}):`, err && err.message);
                        }
            }
            // 快取未完整覆蓋查詢區間、讀取失敗，或缺少日期參數：落到下方即時 FinMind 代理
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

// ===================== 靜態快取 helpers =====================

// 嘗試從每日自動更新的靜態 JSON 檔讀取資料。
// 只有當快取的日期範圍「完整覆蓋」請求的 start~end 時才採用，
// 否則回傳 null，讓呼叫端 fallback 到即時 FinMind 代理。
async function tryStaticCache(origin, dataset, start, end, dataId) {
        const cfg = STATIC_CACHE_CONFIG[dataset];
        if (!cfg) return null;
        if (dataId && dataId !== cfg.expected) return null; // 快取只涵蓋固定的 data_id

  const res = await fetch(origin + cfg.file, {
            cf: { cacheTtl: 300, cacheEverything: true }
  });
        if (!res.ok) return null;

  const json = await res.json();
        const rows = Array.isArray(json.data) ? json.data : [];
        if (rows.length === 0) return null;

  const dates = rows.map(r => r.date).filter(Boolean).sort();
        const cacheMin = dates[0];
        const cacheMax = dates[dates.length - 1];
        if (cacheMin > start || cacheMax < end) return null; // 未完整覆蓋，交給即時查詢

  const filtered = rows.filter(r => r.date >= start && r.date <= end);
        return filtered.length > 0 ? filtered : null;
}

// ===================== TWSE helpers =====================

async function fetchTwseRange(startISO, endISO) {
        const days = enumerateDates(startISO, endISO);
        const out = [];
        for (let i = 0; i < days.length; i += TWSE_CONCURRENCY) {
                  const slice = days.slice(i, i + TWSE_CONCURRENCY);
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

// 從 endISO 往前逐日尋找最近一個有資料的交易日（最多 maxDays 天）
async function findLatestTwseDay(endISO, maxDays) {
        let d = new Date(endISO + "T00:00:00Z");
        for (let i = 0; i < maxDays; i++) {
                  const iso = d.toISOString().slice(0, 10);
                  try {
                              const rows = await fetchTwseOneDay(iso);
                              if (rows && rows.length) return rows;
                  } catch (err) {
                              console.error(`TWSE lookback ${iso} failed:`, err && err.message);
                  }
                  d.setUTCDate(d.getUTCDate() - 1);
        }
        return [];
}

async function fetchTwseOneDay(isoDate) {
        const d = new Date(isoDate + "T00:00:00Z");
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
                              buy: parseTwseNum(row[1]),
                              sell: parseTwseNum(row[2])
                  };
        }
        const fm = map[TW_FOREIGN_MAIN] || { buy: 0, sell: 0 };
        const fs = map[TW_FOREIGN_SELF] || { buy: 0, sell: 0 };

  return [
        { date: isoDate, name: "Foreign_Investor", buy: fm.buy, sell: fm.sell },
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
        const s = new Date(startISO + "T00:00:00Z");
        const e = new Date(endISO + "T00:00:00Z");
        if (isNaN(s) || isNaN(e) || s > e) return out;
        let cnt = 0;
        for (let d = new Date(s); d <= e && cnt < TWSE_MAX_DAYS;
                 d.setUTCDate(d.getUTCDate() + 1), cnt++) {
                  out.push(d.toISOString().slice(0, 10));
        }
        return out;
}

// 計算區間內的平日（週一~週五）數量，用於偵測 FinMind 是否忽略了 end_date
function countWeekdays(startISO, endISO) {
        return enumerateDates(startISO, endISO).filter(iso => {
                  const dow = new Date(iso + "T00:00:00Z").getUTCDay();
                  return dow !== 0 && dow !== 6;
        }).length;
}

// ===================== misc =====================

function jsonResponse(obj, status, cacheSec) {
        return new Response(JSON.stringify(obj), {
                  status: status || 200,
                  headers: {
                              "Content-Type": "application/json; charset=utf-8",
                              "Access-Control-Allow-Origin": "*",
                              "Cache-Control": cacheSec ? `public, max-age=${cacheSec}` : "no-store"
                  }
        });
}
