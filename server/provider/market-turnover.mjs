import { requestTimeoutMs } from "../config.mjs";

const CALENDAR_ENDPOINT = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const SSE_ENDPOINT = "https://query.sse.com.cn/commonQuery.do";
const SZSE_ENDPOINT = "https://www.szse.cn/api/report/ShowReport/data";
const EASTMONEY_KLINE_ENDPOINT = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const ASHARE_INDEXES = {
  shanghai: { secid: "1.000002", code: "000002", name: "上证A股指数" },
  shenzhen: { secid: "0.399107", code: "399107", name: "深证A指" },
};

function finiteNumber(value) {
  const number = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(number) ? number : null;
}

async function fetchJson(endpoint, params, referer) {
  const url = new URL(endpoint);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/plain,*/*",
        Referer: referer,
        "User-Agent": "Mozilla/5.0 MoneyFlowLocal/1.0",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) throw new Error("empty response");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export function parseTradingDates(payload, limit = 30) {
  const rows = payload?.data?.sh000001?.day || payload?.data?.sh000001?.qfqday || [];
  return rows
    .map((row) => String(row?.[0] || ""))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .slice(-limit);
}

export function parseSseTurnover(payload) {
  const rows = Array.isArray(payload?.result) ? payload.result : [];
  const mainA = rows.find((row) => String(row.PRODUCT_CODE) === "01");
  const star = rows.find((row) => String(row.PRODUCT_CODE) === "03");
  const mainAmountYi = finiteNumber(mainA?.TRADE_AMT);
  const starAmountYi = finiteNumber(star?.TRADE_AMT);
  if (mainAmountYi === null || starAmountYi === null) {
    throw new Error("上交所返回中缺少主板A股或科创板成交金额");
  }
  return (mainAmountYi + starAmountYi) * 100_000_000;
}

function normalizeSzseLabel(value) {
  return String(value || "").replaceAll("&nbsp;", "").replaceAll(/\s/g, "");
}

export function parseSzseTurnover(payload) {
  const tab = Array.isArray(payload) ? payload.find((item) => item?.metadata?.tabkey === "tab1") : null;
  const rows = Array.isArray(tab?.data) ? tab.data : [];
  const mainA = rows.find((row) => normalizeSzseLabel(row.lbmc) === "主板A股");
  const chinext = rows.find((row) => normalizeSzseLabel(row.lbmc) === "创业板A股");
  const mainAmountYi = finiteNumber(mainA?.cjje);
  const chinextAmountYi = finiteNumber(chinext?.cjje);
  if (mainAmountYi === null || chinextAmountYi === null) {
    throw new Error("深交所返回中缺少主板A股或创业板A股成交金额");
  }
  return (mainAmountYi + chinextAmountYi) * 100_000_000;
}

export function parseIndexTurnoverKlines(payload, market) {
  const expected = ASHARE_INDEXES[market];
  if (!expected) throw new Error(`未知A股指数市场: ${market}`);
  const code = String(payload?.data?.code || "");
  if (code && code !== expected.code) {
    throw new Error(`${market} A股指数代码不匹配: ${code}`);
  }
  const rows = Array.isArray(payload?.data?.klines) ? payload.data.klines : [];
  return rows.flatMap((line) => {
    const values = String(line || "").split(",");
    const timestamp = values[0];
    const turnoverYuan = finiteNumber(values[6]);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(timestamp) || turnoverYuan === null || turnoverYuan < 0) {
      return [];
    }
    return [{
      market,
      timestamp,
      tradeDate: timestamp.slice(0, 10),
      minute: timestamp.slice(11),
      turnoverYuan,
    }];
  });
}

export function combineAshareIndexTurnover(shanghaiRows, shenzhenRows) {
  const shenzhenByTimestamp = new Map(shenzhenRows.map((row) => [row.timestamp, row]));
  return shanghaiRows.flatMap((shanghai) => {
    const shenzhen = shenzhenByTimestamp.get(shanghai.timestamp);
    if (!shenzhen) return [];
    return [{
      timestamp: shanghai.timestamp,
      tradeDate: shanghai.tradeDate,
      minute: shanghai.minute,
      shanghaiTurnoverYuan: shanghai.turnoverYuan,
      shenzhenTurnoverYuan: shenzhen.turnoverYuan,
      totalTurnoverYuan: shanghai.turnoverYuan + shenzhen.turnoverYuan,
    }];
  }).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function compactDate(date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

export async function fetchAshareIndexTurnoverKlines({ lookbackCalendarDays = 60 } = {}) {
  const endDate = new Date();
  const beginDate = new Date(endDate.getTime() - Math.max(30, lookbackCalendarDays) * 86_400_000);
  const params = {
    klt: 5,
    fqt: 0,
    lmt: 3000,
    beg: compactDate(beginDate),
    end: compactDate(endDate),
    fields1: "f1,f2,f3,f4,f5,f6,f7,f8",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58",
  };
  const [shanghaiPayload, shenzhenPayload] = await Promise.all([
    fetchJson(EASTMONEY_KLINE_ENDPOINT, { ...params, secid: ASHARE_INDEXES.shanghai.secid }, "https://quote.eastmoney.com/zs000002.html"),
    fetchJson(EASTMONEY_KLINE_ENDPOINT, { ...params, secid: ASHARE_INDEXES.shenzhen.secid }, "https://quote.eastmoney.com/zs399107.html"),
  ]);
  const shanghaiRows = parseIndexTurnoverKlines(shanghaiPayload, "shanghai");
  const shenzhenRows = parseIndexTurnoverKlines(shenzhenPayload, "shenzhen");
  const rows = combineAshareIndexTurnover(shanghaiRows, shenzhenRows);
  if (!rows.length) throw new Error("没有读取到沪深A股指数5分钟成交额");
  return rows;
}

export async function fetchTradingDates(limit = 30) {
  const payload = await fetchJson(CALENDAR_ENDPOINT, {
    param: `sh000001,day,,,${limit + 15},qfq`,
  }, "https://gu.qq.com/sh000001");
  const dates = parseTradingDates(payload, limit);
  if (!dates.length) throw new Error("没有读取到交易日历");
  return dates;
}

export async function fetchMarketTurnoverDay(tradeDate) {
  const [ssePayload, szsePayload] = await Promise.all([
    fetchJson(SSE_ENDPOINT, {
      sqlId: "COMMON_SSE_SJ_GPSJ_CJGK_MRGK_C",
      PRODUCT_CODE: "01,02,03,11,17",
      type: "inParams",
      SEARCH_DATE: tradeDate,
      stockType: "90",
    }, "https://www.sse.com.cn/market/stockdata/overview/day/"),
    fetchJson(SZSE_ENDPOINT, {
      SHOWTYPE: "JSON",
      CATALOGID: "1803_sczm",
      TABKEY: "tab1",
      txtQueryDate: tradeDate,
    }, "https://www.szse.cn/market/overview/index.html"),
  ]);
  const shanghaiTurnoverYuan = parseSseTurnover(ssePayload);
  const shenzhenTurnoverYuan = parseSzseTurnover(szsePayload);
  if (shanghaiTurnoverYuan <= 0 || shenzhenTurnoverYuan <= 0) {
    throw new Error("交易所当日正式成交额尚未发布，暂不写入正式历史表");
  }
  return {
    tradeDate,
    shanghaiTurnoverYuan,
    shenzhenTurnoverYuan,
    totalTurnoverYuan: shanghaiTurnoverYuan + shenzhenTurnoverYuan,
    sourceNote: "SSE/SZSE official daily overview · A shares only",
  };
}
