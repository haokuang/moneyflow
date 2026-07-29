import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MoneyflowDatabase } from "../server/db.mjs";
import { parseMinuteKlines } from "../server/provider/eastmoney.mjs";
import {
  parseSseTurnover,
  parseSzseTurnover,
  parseTradingDates,
} from "../server/provider/market-turnover.mjs";

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
    ]);
    const cachedConstituents = await database.getCachedConstituents("industry", "BK1", 5);
    assert.deepEqual(cachedConstituents.map((item) => item.code), ["600001", "000002"]);

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
    assert.equal(status.constituentSnapshotCount, 3);
    assert.equal(status.stockMinuteRowCount, 3);
    assert.equal(status.stockCount, 2);
    assert.equal(status.latestStockTradeDate, "2026-07-22");
    assert.equal(status.latestStockMinute, "15:00");
    assert.equal(status.marketTurnoverDayCount, 2);
    assert.equal(status.latestMarketTurnoverDate, "2026-07-22");
  } finally {
    await database.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
