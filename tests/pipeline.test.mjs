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
    const mk = (code, name, minute, main) => ({
      tradeDate: "2026-07-22",
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
    ]);
    const result = await database.getFlowSeries({ boardType: "industry", flowType: "main", limit: 2, tradeDate: "2026-07-22" });
    const first = result.series.find((series) => series.code === "BK1");
    assert.deepEqual(first.points.map((point) => [point.time, point.main]), [["09:30", 3], ["09:35", 6]]);
    const status = await database.getStatus();
    assert.equal(status.sectorCount, 2);
    assert.equal(status.minuteRowCount, 6);
  } finally {
    await database.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
