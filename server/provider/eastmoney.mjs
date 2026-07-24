import { requestTimeoutMs } from "../config.mjs";

const LIST_ENDPOINTS = [
  "https://push2.eastmoney.com/api/qt/clist/get",
  "https://push2his.eastmoney.com/api/qt/clist/get",
];

const FLOW_ENDPOINTS = [
  "https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get",
  "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get",
];

let emptyFlowDiagnosticLogged = false;

function rowsFromDiff(diff) {
  if (Array.isArray(diff)) return diff;
  if (diff && typeof diff === "object") return Object.values(diff);
  return [];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function fetchJson(endpoint, params) {
  const url = new URL(endpoint);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  url.searchParams.set("_", String(Date.now()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/plain,*/*",
        Referer: "https://data.eastmoney.com/bkzj/jlr.html",
        "User-Agent": "Mozilla/5.0 MoneyFlowLocal/1.0",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) throw new Error("empty response");
    const jsonText = text.trim().startsWith("{")
      ? text.trim()
      : text.slice(text.indexOf("(") + 1, text.lastIndexOf(")"));
    return JSON.parse(jsonText);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithFallback(endpoints, params) {
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const payload = await fetchJson(endpoint, params);
      return { payload, endpoint };
    } catch (error) {
      errors.push(`${new URL(endpoint).host}: ${error.message}`);
    }
  }
  throw new Error(errors.join("; "));
}

export function parseMinuteKlines(payload, board) {
  const klines = payload?.data?.klines;
  if (!Array.isArray(klines)) return [];
  return klines.flatMap((line) => {
    const values = String(line).split(",");
    const match = String(values[0] || "").match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    if (!match) return [];
    const [main, small, medium, large, superValue] = values.slice(1, 6).map(finiteNumber);
    if ([main, small, medium, large, superValue].some((value) => value === null)) return [];
    return [{
      tradeDate: match[1],
      minute: match[2],
      ...(board.market !== undefined && board.market !== null
        ? { market: String(board.market) }
        : { boardType: board.boardType }),
      code: board.code,
      name: board.name,
      mainFlowYuan: main,
      smallFlowYuan: small,
      mediumFlowYuan: medium,
      largeFlowYuan: large,
      superFlowYuan: superValue,
    }];
  });
}

export async function fetchBoardCandidates(boardType, perSide) {
  const fs = boardType === "industry" ? "m:90+t:2" : "m:90+t:3";
  const base = {
    pn: 1,
    pz: perSide,
    np: 1,
    fltt: 2,
    invt: 2,
    fid: "f62",
    fs,
    fields: "f12,f14,f62",
    ut: "bd1d9ddb04089700cf9c27f6f7426281",
  };
  const responses = await Promise.allSettled([
    fetchWithFallback(LIST_ENDPOINTS, { ...base, po: 1 }),
    fetchWithFallback(LIST_ENDPOINTS, { ...base, po: 0 }),
  ]);
  const rows = responses.flatMap((result) => result.status === "fulfilled" ? rowsFromDiff(result.value.payload?.data?.diff) : []);
  if (!rows.length) {
    const reasons = responses.filter((item) => item.status === "rejected").map((item) => item.reason.message);
    throw new Error(`板块目录读取失败: ${reasons.join(" | ")}`);
  }
  const deduped = [...new Map(rows.map((row) => [row.f12, row])).values()];
  return deduped
    .filter((row) => row.f12 && row.f14)
    .map((row) => ({
      boardType,
      code: row.f12,
      name: row.f14,
      snapshotFlowYuan: finiteNumber(row.f62) || 0,
    }))
    .sort((a, b) => Math.abs(b.snapshotFlowYuan) - Math.abs(a.snapshotFlowYuan))
    .slice(0, perSide * 2);
}

export async function fetchBoardMinuteFlow(board) {
  const params = {
    secid: `90.${board.code}`,
    lmt: 0,
    klt: 1,
    fields1: "f1,f2,f3,f7",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
    ut: "b2884a393a59ad64002292a3e90d46a5",
  };
  const errors = [];
  for (const endpoint of FLOW_ENDPOINTS) {
    try {
      const payload = await fetchJson(endpoint, params);
      const rows = parseMinuteKlines(payload, board);
      if (rows.length) return { rows, sourceHost: new URL(endpoint).host };
      errors.push(`${new URL(endpoint).host}: empty klines`);
      if (!emptyFlowDiagnosticLogged) {
        emptyFlowDiagnosticLogged = true;
        console.warn(`[provider] empty minute payload for ${board.code}: ${JSON.stringify(payload).slice(0, 1000)}`);
      }
    } catch (error) {
      errors.push(`${new URL(endpoint).host}: ${error.message}`);
    }
  }
  throw new Error(`${board.name}没有分钟资金数据 (${errors.join("; ")})`);
}

export async function fetchSectorConstituents(board, limit = 5) {
  const { payload, endpoint } = await fetchWithFallback(LIST_ENDPOINTS, {
    pn: 1,
    pz: limit,
    po: 1,
    np: 1,
    fltt: 2,
    invt: 2,
    fid: "f62",
    fs: `b:${board.code}`,
    fields: "f12,f13,f14,f2,f3,f62,f184",
    ut: "bd1d9ddb04089700cf9c27f6f7426281",
  });
  const rows = rowsFromDiff(payload?.data?.diff);
  if (!rows.length) throw new Error(`${board.name}没有成分股数据`);
  return {
    sourceHost: new URL(endpoint).host,
    items: rows
      .filter((row) => row.f12 && row.f14 && row.f13 !== undefined && row.f13 !== null)
      .slice(0, limit)
      .map((row, index) => ({
        boardType: board.boardType,
        boardCode: board.code,
        boardName: board.name,
        market: String(row.f13),
        code: row.f12,
        name: row.f14,
        rank: index + 1,
        snapshotPrice: finiteNumber(row.f2) || 0,
        snapshotChangePct: finiteNumber(row.f3) || 0,
        snapshotMainFlowYuan: finiteNumber(row.f62) || 0,
        snapshotMainFlowRatio: finiteNumber(row.f184) || 0,
      })),
  };
}

export async function fetchStockMinuteFlow(stock) {
  const params = {
    secid: `${stock.market}.${stock.code}`,
    lmt: 0,
    klt: 1,
    fields1: "f1,f2,f3,f7",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
    ut: "b2884a393a59ad64002292a3e90d46a5",
  };
  const errors = [];
  for (const endpoint of FLOW_ENDPOINTS) {
    try {
      const payload = await fetchJson(endpoint, params);
      const rows = parseMinuteKlines(payload, stock);
      if (rows.length) return { rows, sourceHost: new URL(endpoint).host };
      errors.push(`${new URL(endpoint).host}: empty klines`);
    } catch (error) {
      errors.push(`${new URL(endpoint).host}: ${error.message}`);
    }
  }
  throw new Error(`${stock.name}没有分钟资金数据 (${errors.join("; ")})`);
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
