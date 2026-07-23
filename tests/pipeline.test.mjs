import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MoneyflowDatabase } from "../server/db.mjs";
import { parseMinuteKlines } from "../server/provider/eastmoney.mjs";

test("parses Eastmoney one-minute cumulative fields without changing units", () => {
  const rows = parseMinuteKlines({ data: { klines: ["2026-07-22 09:31,100000000,-20000000,30000000,40000000,60000000"] } }, {
    boardType: "industry",
    code: "BKTEST",
    name: "测试板块",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mainFlowYuan, 100000000);
  assert.equal(rows[0].superFlowYuan, 60000000);
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

    const status = await database.getStatus();
    assert.equal(status.sectorCount, 2);
    assert.equal(status.minuteRowCount, 8);
  } finally {
    await database.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
