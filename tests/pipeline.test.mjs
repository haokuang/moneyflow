import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MoneyflowDatabase } from "../server/db.mjs";
import { parseMinuteKlines } from "../server/provider/eastmoney.mjs";
import {
  combineAshareIndexTurnover,
  combineAshareIndexVolume,
  parseIndexTurnoverKlines,
  parseSseTurnover,
  parseSzseTurnover,
  parseTencentIndexQuotes,
  parseTencentIndexVolumeKlines,
  parseTradingDates,
} from "../server/provider/market-turnover.mjs";
import { MarketTurnoverEstimator, estimateIntradayMarketTurnover } from "../server/market-turnover-estimator.mjs";

function makeTurnoverEstimateFixture() {
  const rows = [];
  for (let day = 20; day <= 25; day += 1) {
    const tradeDate = `2026-07-${day}`;
    rows.push({
      tradeDate,
      minute: "10:00",
      shanghaiTurnoverYuan: 2000 * 100_000_000,
      shenzhenTurnoverYuan: 2250 * 100_000_000,
      totalTurnoverYuan: 4250 * 100_000_000,
    });
    rows.push({
      tradeDate,
      minute: "15:00",
      shanghaiTurnoverYuan: 6000 * 100_000_000,
      shenzhenTurnoverYuan: 6750 * 100_000_000,
      totalTurnoverYuan: 12750 * 100_000_000,
    });
  }
  rows.push({
    tradeDate: "2026-07-29",
    minute: "10:00",
    shanghaiTurnoverYuan: 3000 * 100_000_000,
    shenzhenTurnoverYuan: 4000 * 100_000_000,
    totalTurnoverYuan: 7000 * 100_000_000,
  });
  const officialPoints = Array.from({ length: 6 }, (_, index) => ({
    tradeDate: `2026-07-${20 + index}`,
    shanghai: 8000,
    shenzhen: 9000,
    total: 17000,
  }));
  return { rows, officialPoints };
}

test("parses Eastmoney one-minute cumulative fields without changing units", () => {
  const rows = parseMinuteKlines({ data: { klines: ["2026-07-22 09:31,100000000,-20000000,30000000,40000000,60000000"] } }, {
    boardType: "industry",
    code: "BKTEST",
    name: "测试板块",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mainFlowYuan, 100000000);
  assert.equal(rows[0].superFlowYuan, 60000000);

  const stockRows = parseMinuteKlines(
    { data: { klines: ["2026-07-22 09:31,80000000,-10000000,20000000,30000000,50000000"] } },
    { market: "1", code: "600001", name: "样本股票" },
  );
  assert.equal(stockRows[0].market, "1");
  assert.equal(stockRows[0].code, "600001");
  assert.equal(stockRows[0].mainFlowYuan, 80000000);
});

test("parses official exchange A-share turnover without mixing B shares or funds", () => {
  assert.deepEqual(parseTradingDates({
    data: { sh000001: { day: [["2026-07-23"], ["2026-07-24"], ["2026-07-27"]] } },
  }, 2), ["2026-07-24", "2026-07-27"]);

  const shanghai = parseSseTurnover({
    result: [
      { PRODUCT_CODE: "01", TRADE_AMT: "6,267.15" },
      { PRODUCT_CODE: "02", TRADE_AMT: "1.72" },
      { PRODUCT_CODE: "03", TRADE_AMT: "2,894.15" },
    ],
  });
  const shenzhen = parseSzseTurnover([{
    metadata: { tabkey: "tab1" },
    data: [
      { lbmc: "股票", cjje: "10,168.80" },
      { lbmc: "&nbsp;&nbsp;主板A股", cjje: "5,671.17" },
      { lbmc: "&nbsp;&nbsp;主板B股", cjje: "0.46" },
      { lbmc: "&nbsp;&nbsp;创业板A股", cjje: "4,497.16" },
      { lbmc: "基金", cjje: "1,535.12" },
    ],
  }]);
  assert.equal(shanghai, 9161.3 * 100_000_000);
  assert.equal(shenzhen, 10168.33 * 100_000_000);
});

test("parses and combines Shanghai and Shenzhen A-share index turnover bars", () => {
  const shanghai = parseIndexTurnoverKlines({
    data: { code: "000002", klines: ["2026-07-29 10:00,1,1,1,1,1,300000000000.00,0"] },
  }, "shanghai");
  const shenzhen = parseIndexTurnoverKlines({
    data: { code: "399107", klines: ["2026-07-29 10:00,1,1,1,1,1,400000000000.00,0"] },
  }, "shenzhen");
  assert.deepEqual(combineAshareIndexTurnover(shanghai, shenzhen), [{
    timestamp: "2026-07-29 10:00",
    tradeDate: "2026-07-29",
    minute: "10:00",
    shanghaiTurnoverYuan: 300000000000,
    shenzhenTurnoverYuan: 400000000000,
    totalTurnoverYuan: 700000000000,
  }]);
});

test("parses Tencent index volume profiles and exact live cumulative turnover", () => {
  const shanghai = parseTencentIndexVolumeKlines({
    data: { sh000002: { m5: [["202607291500", "1", "1", "1", "1", "500000000", {}, "1"]] } },
  }, "shanghai");
  const shenzhen = parseTencentIndexVolumeKlines({
    data: { sz399107: { m5: [["202607291500", "1", "1", "1", "1", "600000000", {}, "1"]] } },
  }, "shenzhen");
  assert.deepEqual(combineAshareIndexVolume(shanghai, shenzhen), [{
    timestamp: "2026-07-29 15:00",
    tradeDate: "2026-07-29",
    minute: "15:00",
    shanghaiProfileValue: 500000000,
    shenzhenProfileValue: 600000000,
    totalProfileValue: 1100000000,
    estimateProfile: "volume-proxy",
  }]);

  const quoteLine = (code, timestamp, amount) => {
    const fields = Array(36).fill("");
    fields[30] = timestamp;
    fields[35] = `1/2/${amount}`;
    return `v_${code}="${fields.join("~")}"`;
  };
  const quotes = parseTencentIndexQuotes([
    quoteLine("sh000002", "20260730135348", "876524077535"),
    quoteLine("sz399107", "20260730135348", "996342343585"),
  ].join(";\n"));
  assert.equal(quotes.shanghai.tradeDate, "2026-07-30");
  assert.equal(quotes.shanghai.minute, "13:53");
  assert.equal(quotes.shanghai.turnoverYuan, 876524077535);
  assert.equal(quotes.shenzhen.turnoverYuan, 996342343585);
});

test("estimates current full-day turnover from robust historical completion and recent official level", () => {
  const { rows, officialPoints } = makeTurnoverEstimateFixture();
  const estimate = estimateIntradayMarketTurnover(rows, officialPoints);
  assert.equal(estimate.tradeDate, "2026-07-29");
  assert.equal(estimate.observedAt, "10:00");
  assert.equal(estimate.observedTotal, 7000);
  assert.equal(estimate.completionRatio, 0.25);
  assert.equal(estimate.historyDays, 6);
  assert.equal(estimate.total, 21400);
  assert.equal(estimate.isEstimate, true);
  assert.match(estimate.method, /历史同期成交占比中位数/);
  assert.equal(estimateIntradayMarketTurnover(rows, [...officialPoints, {
    tradeDate: "2026-07-29",
    shanghai: 11000,
    shenzhen: 12000,
    total: 23000,
  }]), null);
});

test("marks volume-profile fallback estimates explicitly", () => {
  const { rows, officialPoints } = makeTurnoverEstimateFixture();
  const proxyRows = rows.map((row) => ({
    ...row,
    shanghaiProfileValue: row.shanghaiTurnoverYuan / 100,
    shenzhenProfileValue: row.shenzhenTurnoverYuan / 100,
    totalProfileValue: row.totalTurnoverYuan / 100,
  }));
  const current = proxyRows.at(-1);
  current.estimateProfile = "volume-proxy";
  current.estimateSourceNote = "fixture volume proxy";
  const estimate = estimateIntradayMarketTurnover(proxyRows, officialPoints);
  assert.equal(estimate.profileBasis, "volume-proxy");
  assert.match(estimate.method, /成交量占比中位数/);
  assert.equal(estimate.sourceNote, "fixture volume proxy");
  assert.equal(estimate.total, 21400);
});

test("keeps a clearly marked short-lived turnover estimate when refresh fails", async () => {
  const { rows, officialPoints } = makeTurnoverEstimateFixture();
  let clock = 1_000_000;
  let fetchCount = 0;
  const estimator = new MarketTurnoverEstimator({
    refreshMs: 60_000,
    maxStaleMs: 300_000,
    now: () => clock,
    fetchRows: async () => {
      fetchCount += 1;
      if (fetchCount === 1) return rows;
      throw new Error("temporary upstream socket close");
    },
  });
  const payload = {
    meta: { count: officialPoints.length, latestTradeDate: officialPoints.at(-1).tradeDate },
    points: officialPoints,
  };

  const fresh = await estimator.enhanceHistory(payload, 30);
  assert.equal(fresh.meta.isLatestEstimate, true);
  assert.equal(fresh.meta.estimate.isStale, false);
  assert.equal(fresh.points.at(-1).isStaleEstimate, false);

  clock += 61_000;
  const stale = await estimator.enhanceHistory(payload, 30);
  assert.equal(stale.meta.isLatestEstimate, true);
  assert.equal(stale.meta.estimate.isStale, true);
  assert.equal(stale.meta.estimate.sourceAgeSeconds, 61);
  assert.match(stale.meta.estimate.sourceError, /socket close/);
  assert.equal(stale.points.at(-1).isStaleEstimate, true);

  clock += 300_000;
  const expired = await estimator.enhanceHistory(payload, 30);
  assert.equal(expired.meta.isLatestEstimate, undefined);
  assert.match(expired.meta.estimateError, /socket close/);
  assert.equal(expired.points.at(-1).tradeDate, "2026-07-25");
});

test("persists one-minute rows and aggregates each five-minute bucket with last, not sum", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moneyflow-duckdb-"));
  const database = await MoneyflowDatabase.create(path.join(tempDir, "test.duckdb"));
  try {
    await database.upsertCatalog([
      { boardType: "industry", code: "BK1", name: "板块一", snapshotFlowYuan: 600000000 },
      { boardType: "industry", code: "BK2", name: "板块二", snapshotFlowYuan: -200000000 },
    ]);
    const mk = (code, name, minute, main, tradeDate = "2026-07-22") => ({
      tradeDate,
      boardType: "industry",
      code,
      name,
      minute,
      mainFlowYuan: main,
      smallFlowYuan: -main * 0.2,
      mediumFlowYuan: -main * 0.3,
      largeFlowYuan: main * 0.4,
      superFlowYuan: main * 0.6,
      sourceHost: "fixture",
    });
    await database.upsertMinuteRows([
      mk("BK1", "板块一", "09:30", 100000000),
      mk("BK1", "板块一", "09:34", 300000000),
      mk("BK1", "板块一", "09:35", 400000000),
      mk("BK1", "板块一", "09:39", 600000000),
      mk("BK2", "板块二", "09:30", -100000000),
      mk("BK2", "板块二", "09:34", -200000000),
      mk("BK1", "板块一", "09:30", 80000000, "2026-07-21"),
      mk("BK2", "板块二", "09:30", -50000000, "2026-07-21"),
    ]);
    const fiveMinute = await database.getFlowSeries({
      boardType: "industry",
      flowType: "main",
      limit: 2,
      tradeDate: "2026-07-22",
      interval: "5m",
    });
    const fiveMinuteFirst = fiveMinute.series.find((series) => series.code === "BK1");
    assert.deepEqual(fiveMinuteFirst.points.map((point) => [point.time, point.main]), [["09:30", 3], ["09:35", 6]]);
    assert.equal(fiveMinute.meta.interval, "5m");
    assert.equal(fiveMinute.meta.latestMinute, "09:39");

    const oneMinute = await database.getFlowSeries({
      boardType: "industry",
      flowType: "main",
      limit: 2,
      tradeDate: "2026-07-22",
      interval: "1m",
    });
    const oneMinuteFirst = oneMinute.series.find((series) => series.code === "BK1");
    assert.deepEqual(oneMinuteFirst.points.map((point) => [point.time, point.main]), [
      ["09:30", 1],
      ["09:34", 3],
      ["09:35", 4],
      ["09:39", 6],
    ]);
    assert.equal(oneMinute.meta.interval, "1m");
    assert.equal(oneMinute.meta.latestMinute, "09:39");

    const tradeDates = await database.getTradeDates("industry");
    assert.deepEqual(tradeDates.dates.map((item) => item.tradeDate), ["2026-07-22", "2026-07-21"]);
    assert.equal(tradeDates.dates[0].latestMinute, "09:39");
    assert.equal(tradeDates.dates[0].rowCount, 6);
    assert.equal(tradeDates.dates[0].sectorCount, 2);

    await database.upsertConstituentSnapshots([
      {
        tradeDate: "2026-07-22",
        snapshotMinute: "15:00",
        boardType: "industry",
        boardCode: "BK1",
        boardName: "板块一",
        market: "1",
        code: "600001",
        name: "股票一",
        rank: 1,
        snapshotPrice: 12.3,
        snapshotChangePct: 2.1,
        snapshotMainFlowYuan: 500000000,
        snapshotMainFlowRatio: 8.2,
        sourceHost: "fixture",
      },
      {
        tradeDate: "2026-07-22",
        snapshotMinute: "15:00",
        boardType: "industry",
        boardCode: "BK1",
        boardName: "板块一",
        market: "0",
        code: "000002",
        name: "股票二",
        rank: 2,
        snapshotPrice: 8.6,
        snapshotChangePct: 1.2,
        snapshotMainFlowYuan: 300000000,
        snapshotMainFlowRatio: 5.5,
        sourceHost: "fixture",
      },
      {
        tradeDate: "2026-07-22",
        snapshotMinute: "15:00",
        boardType: "industry",
        boardCode: "BK2",
        boardName: "板块二",
        market: "1",
        code: "600001",
        name: "股票一",
        rank: 1,
        snapshotPrice: 12.3,
        snapshotChangePct: 2.1,
        snapshotMainFlowYuan: 500000000,
        snapshotMainFlowRatio: 8.2,
        sourceHost: "fixture",
      },
      {
        tradeDate: "2026-07-22",
        snapshotMinute: "15:00",
        boardType: "industry",
        boardCode: "BK1",
        boardName: "板块一",
        market: "1",
        code: "600003",
        name: "股票三",
        rank: 1001,
        snapshotPrice: 6.3,
        snapshotChangePct: -3.1,
        snapshotMainFlowYuan: -400000000,
        snapshotMainFlowRatio: -6.2,
        sourceHost: "fixture",
      },
      {
        tradeDate: "2026-07-22",
        snapshotMinute: "15:00",
        boardType: "industry",
        boardCode: "BK1",
        boardName: "板块一",
        market: "0",
        code: "000004",
        name: "股票四",
        rank: 1002,
        snapshotPrice: 10.2,
        snapshotChangePct: -1.5,
        snapshotMainFlowYuan: -200000000,
        snapshotMainFlowRatio: -3.8,
        sourceHost: "fixture",
      },
    ]);
    const stockMk = (market, code, name, minute, main) => ({
      tradeDate: "2026-07-22",
      market,
      code,
      name,
      minute,
      mainFlowYuan: main,
      smallFlowYuan: -main * 0.2,
      mediumFlowYuan: -main * 0.3,
      largeFlowYuan: main * 0.4,
      superFlowYuan: main * 0.6,
      sourceHost: "fixture",
    });
    await database.upsertStockMinuteRows([
      stockMk("1", "600001", "股票一", "09:30", 100000000),
      stockMk("1", "600001", "股票一", "15:00", 500000000),
      stockMk("0", "000002", "股票二", "15:00", 300000000),
      stockMk("1", "600003", "股票三", "15:00", -400000000),
      stockMk("0", "000004", "股票四", "15:00", -200000000),
    ]);
    const cachedConstituents = await database.getCachedConstituents("industry", "BK1", 5);
    assert.deepEqual(cachedConstituents.map((item) => item.code), ["600001", "000002", "600003", "000004"]);

    const leaders = await database.getSectorStockLeaders({
      boardType: "industry",
      boardCode: "BK1",
      tradeDate: "2026-07-22",
      flowType: "main",
      limit: 5,
    });
    assert.equal(leaders.meta.snapshotMinute, "15:00");
    assert.equal(leaders.meta.latestMinute, "15:00");
    assert.deepEqual(leaders.stocks.map((item) => [item.code, item.selectedFlow]), [
      ["600001", 5],
      ["000002", 3],
    ]);
    assert.equal(leaders.meta.direction, "inflow");

    const outflows = await database.getSectorStockLeaders({
      boardType: "industry",
      boardCode: "BK1",
      tradeDate: "2026-07-22",
      flowType: "main",
      direction: "outflow",
      limit: 5,
    });
    assert.equal(outflows.meta.direction, "outflow");
    assert.deepEqual(outflows.stocks.map((item) => [item.code, item.selectedFlow]), [
      ["600003", -4],
      ["000004", -2],
    ]);

    await database.upsertMarketTurnoverRows([
      {
        tradeDate: "2026-07-21",
        shanghaiTurnoverYuan: 7000 * 100_000_000,
        shenzhenTurnoverYuan: 8000 * 100_000_000,
        totalTurnoverYuan: 15000 * 100_000_000,
        sourceNote: "fixture",
      },
      {
        tradeDate: "2026-07-22",
        shanghaiTurnoverYuan: 8000 * 100_000_000,
        shenzhenTurnoverYuan: 9000 * 100_000_000,
        totalTurnoverYuan: 17000 * 100_000_000,
        sourceNote: "fixture",
      },
      {
        tradeDate: "2026-07-23",
        shanghaiTurnoverYuan: 0,
        shenzhenTurnoverYuan: 0,
        totalTurnoverYuan: 0,
        sourceNote: "unpublished fixture",
      },
    ]);
    const turnoverDates = await database.getMarketTurnoverDates(30);
    assert.deepEqual(turnoverDates, ["2026-07-22", "2026-07-21"]);
    const turnover = await database.getMarketTurnoverHistory(30);
    assert.equal(turnover.meta.count, 2);
    assert.equal(turnover.meta.latestTradeDate, "2026-07-22");
    assert.deepEqual(turnover.points.map((item) => [item.tradeDate, item.total]), [
      ["2026-07-21", 15000],
      ["2026-07-22", 17000],
    ]);

    const status = await database.getStatus();
    assert.equal(status.sectorCount, 2);
    assert.equal(status.minuteRowCount, 8);
    assert.equal(status.constituentSnapshotCount, 5);
    assert.equal(status.stockMinuteRowCount, 5);
    assert.equal(status.stockCount, 4);
    assert.equal(status.latestStockTradeDate, "2026-07-22");
    assert.equal(status.latestStockMinute, "15:00");
    assert.equal(status.marketTurnoverDayCount, 2);
    assert.equal(status.latestMarketTurnoverDate, "2026-07-22");
  } finally {
    await database.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
