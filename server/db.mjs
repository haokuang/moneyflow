import fs from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const FLOW_FIELDS = {
  main: "main_flow_yuan",
  small: "small_flow_yuan",
  medium: "medium_flow_yuan",
  large: "large_flow_yuan",
  super: "super_flow_yuan",
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sector_catalog (
  board_type VARCHAR NOT NULL,
  code VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  snapshot_flow_yuan DOUBLE NOT NULL,
  first_seen_at VARCHAR NOT NULL,
  updated_at VARCHAR NOT NULL,
  PRIMARY KEY (board_type, code)
);

CREATE TABLE IF NOT EXISTS minute_flow (
  trade_date VARCHAR NOT NULL,
  board_type VARCHAR NOT NULL,
  code VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  minute VARCHAR NOT NULL,
  main_flow_yuan DOUBLE NOT NULL,
  small_flow_yuan DOUBLE NOT NULL,
  medium_flow_yuan DOUBLE NOT NULL,
  large_flow_yuan DOUBLE NOT NULL,
  super_flow_yuan DOUBLE NOT NULL,
  collected_at VARCHAR NOT NULL,
  source_host VARCHAR NOT NULL,
  PRIMARY KEY (trade_date, board_type, code, minute)
);

CREATE TABLE IF NOT EXISTS collector_runs (
  run_id VARCHAR PRIMARY KEY,
  reason VARCHAR NOT NULL,
  started_at VARCHAR NOT NULL,
  finished_at VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  boards_requested INTEGER NOT NULL,
  boards_succeeded INTEGER NOT NULL,
  rows_upserted INTEGER NOT NULL,
  error_message VARCHAR
);

CREATE TEMP TABLE IF NOT EXISTS catalog_stage AS SELECT * FROM sector_catalog WHERE false;
CREATE TEMP TABLE IF NOT EXISTS minute_flow_stage AS SELECT * FROM minute_flow WHERE false;

CREATE OR REPLACE VIEW flow_5m AS
WITH normalized AS (
  SELECT
    *,
    substr(minute, 1, 3) || lpad(
      cast(cast(floor(cast(substr(minute, 4, 2) AS INTEGER) / 5) * 5 AS INTEGER) AS VARCHAR),
      2,
      '0'
    ) AS bucket
  FROM minute_flow
)
SELECT
  trade_date,
  board_type,
  code,
  arg_max(name, minute) AS name,
  bucket,
  arg_max(main_flow_yuan, minute) AS main_flow_yuan,
  arg_max(small_flow_yuan, minute) AS small_flow_yuan,
  arg_max(medium_flow_yuan, minute) AS medium_flow_yuan,
  arg_max(large_flow_yuan, minute) AS large_flow_yuan,
  arg_max(super_flow_yuan, minute) AS super_flow_yuan,
  max(collected_at) AS collected_at
FROM normalized
GROUP BY trade_date, board_type, code, bucket;
`;

function nowIso() {
  return new Date().toISOString();
}

export class MoneyflowDatabase {
  static async create(filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const instance = await DuckDBInstance.create(filePath, { threads: "4" });
    const connection = await instance.connect();
    const database = new MoneyflowDatabase(filePath, instance, connection);
    await connection.run(SCHEMA_SQL);
    return database;
  }

  constructor(filePath, instance, connection) {
    this.filePath = filePath;
    this.instance = instance;
    this.connection = connection;
    this.queue = Promise.resolve();
  }

  enqueue(task) {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async upsertCatalog(boards) {
    if (!boards.length) return 0;
    return this.enqueue(async () => {
      await this.connection.run("DELETE FROM catalog_stage");
      const appender = await this.connection.createAppender("catalog_stage");
      const timestamp = nowIso();
      for (const board of boards) {
        appender.appendVarchar(board.boardType);
        appender.appendVarchar(board.code);
        appender.appendVarchar(board.name);
        appender.appendDouble(board.snapshotFlowYuan || 0);
        appender.appendVarchar(timestamp);
        appender.appendVarchar(timestamp);
        appender.endRow();
      }
      appender.closeSync();
      await this.connection.run(`
        INSERT INTO sector_catalog SELECT * FROM catalog_stage
        ON CONFLICT (board_type, code) DO UPDATE SET
          name = excluded.name,
          snapshot_flow_yuan = excluded.snapshot_flow_yuan,
          updated_at = excluded.updated_at
      `);
      return boards.length;
    });
  }

  async getCachedCandidates(boardType, limit) {
    return this.enqueue(async () => {
      const reader = await this.connection.runAndReadAll(`
        SELECT board_type AS boardType, code, name, snapshot_flow_yuan AS snapshotFlowYuan
        FROM sector_catalog
        WHERE board_type = $boardType
        ORDER BY abs(snapshot_flow_yuan) DESC
        LIMIT $limit
      `, { boardType, limit });
      return reader.getRowObjectsJson();
    });
  }

  async upsertMinuteRows(items) {
    if (!items.length) return 0;
    return this.enqueue(async () => {
      await this.connection.run("DELETE FROM minute_flow_stage");
      const appender = await this.connection.createAppender("minute_flow_stage");
      const collectedAt = nowIso();
      for (const item of items) {
        appender.appendVarchar(item.tradeDate);
        appender.appendVarchar(item.boardType);
        appender.appendVarchar(item.code);
        appender.appendVarchar(item.name);
        appender.appendVarchar(item.minute);
        appender.appendDouble(item.mainFlowYuan);
        appender.appendDouble(item.smallFlowYuan);
        appender.appendDouble(item.mediumFlowYuan);
        appender.appendDouble(item.largeFlowYuan);
        appender.appendDouble(item.superFlowYuan);
        appender.appendVarchar(collectedAt);
        appender.appendVarchar(item.sourceHost || "unknown");
        appender.endRow();
      }
      appender.closeSync();
      await this.connection.run(`
        INSERT INTO minute_flow SELECT * FROM minute_flow_stage
        ON CONFLICT (trade_date, board_type, code, minute) DO UPDATE SET
          name = excluded.name,
          main_flow_yuan = excluded.main_flow_yuan,
          small_flow_yuan = excluded.small_flow_yuan,
          medium_flow_yuan = excluded.medium_flow_yuan,
          large_flow_yuan = excluded.large_flow_yuan,
          super_flow_yuan = excluded.super_flow_yuan,
          collected_at = excluded.collected_at,
          source_host = excluded.source_host
      `);
      return items.length;
    });
  }

  async recordRun(run) {
    return this.enqueue(() => this.connection.run(`
      INSERT OR REPLACE INTO collector_runs VALUES (
        $runId, $reason, $startedAt, $finishedAt, $status,
        $boardsRequested, $boardsSucceeded, $rowsUpserted, $errorMessage
      )
    `, run));
  }

  async getTradeDates(boardType, limit = 250) {
    const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 250));
    return this.enqueue(async () => {
      const reader = await this.connection.runAndReadAll(`
        SELECT
          trade_date AS tradeDate,
          max(minute) AS latestMinute,
          max(collected_at) AS collectedAt,
          cast(count(*) AS INTEGER) AS rowCount,
          cast(count(DISTINCT code) AS INTEGER) AS sectorCount
        FROM minute_flow
        WHERE board_type = $boardType
        GROUP BY trade_date
        ORDER BY trade_date DESC
        LIMIT $limit
      `, { boardType, limit: safeLimit });
      return { dates: reader.getRowObjectsJson() };
    });
  }

  async getFlowSeries({
    boardType,
    flowType = "main",
    limit = 18,
    tradeDate = "latest",
    interval = "5m",
  }) {
    const field = FLOW_FIELDS[flowType] || FLOW_FIELDS.main;
    const safeLimit = Math.min(60, Math.max(1, Number(limit) || 18));
    const safeInterval = interval === "1m" ? "1m" : "5m";
    const sourceTable = safeInterval === "1m" ? "minute_flow" : "flow_5m";
    const timeColumn = safeInterval === "1m" ? "minute" : "bucket";
    return this.enqueue(async () => {
      let selectedDate = tradeDate;
      if (!selectedDate || selectedDate === "latest") {
        const dateReader = await this.connection.runAndReadAll(
          "SELECT max(trade_date) AS tradeDate FROM minute_flow WHERE board_type = $boardType",
          { boardType },
        );
        selectedDate = dateReader.getRowObjectsJson()[0]?.tradeDate || null;
      }
      if (!selectedDate) {
        return {
          meta: {
            tradeDate: null,
            latestMinute: null,
            collectedAt: null,
            interval: safeInterval,
          },
          series: [],
        };
      }

      const reader = await this.connection.runAndReadAll(`
        WITH latest AS (
          SELECT
            code,
            arg_max(name, minute) AS name,
            arg_max(${field}, minute) AS latest_value
          FROM minute_flow
          WHERE trade_date = $tradeDate AND board_type = $boardType
          GROUP BY code
        ), ranked AS (
          SELECT *, row_number() OVER (ORDER BY abs(latest_value) DESC, code) AS rank
          FROM latest
        )
        SELECT
          ranked.rank,
          flow.code,
          flow.name,
          flow.${timeColumn} AS time,
          flow.main_flow_yuan / 100000000.0 AS main,
          flow.small_flow_yuan / 100000000.0 AS small,
          flow.medium_flow_yuan / 100000000.0 AS medium,
          flow.large_flow_yuan / 100000000.0 AS large,
          flow.super_flow_yuan / 100000000.0 AS super,
          flow.collected_at
        FROM ${sourceTable} AS flow
        JOIN ranked USING (code)
        WHERE flow.trade_date = $tradeDate
          AND flow.board_type = $boardType
          AND ranked.rank <= $limit
        ORDER BY ranked.rank, flow.${timeColumn}
      `, { tradeDate: selectedDate, boardType, limit: safeLimit });
      const rows = reader.getRowObjectsJson();
      const minuteReader = await this.connection.runAndReadAll(`
        SELECT max(minute) AS latestMinute
        FROM minute_flow
        WHERE trade_date = $tradeDate AND board_type = $boardType
      `, { tradeDate: selectedDate, boardType });
      const grouped = new Map();
      for (const row of rows) {
        if (!grouped.has(row.code)) grouped.set(row.code, { code: row.code, name: row.name, points: [] });
        grouped.get(row.code).points.push({
          time: row.time,
          main: row.main,
          small: row.small,
          medium: row.medium,
          large: row.large,
          super: row.super,
        });
      }
      const latestMinute = minuteReader.getRowObjectsJson()[0]?.latestMinute || null;
      const collectedAt = rows.reduce((latest, row) => row.collected_at > latest ? row.collected_at : latest, "");
      return {
        meta: {
          tradeDate: selectedDate,
          latestMinute,
          collectedAt: collectedAt || null,
          interval: safeInterval,
        },
        series: [...grouped.values()],
      };
    });
  }

  async getStatus() {
    return this.enqueue(async () => {
      const reader = await this.connection.runAndReadAll(`
        SELECT
          cast((SELECT count(*) FROM sector_catalog) AS INTEGER) AS sectorCount,
          cast((SELECT count(*) FROM minute_flow) AS INTEGER) AS minuteRowCount,
          (SELECT max(trade_date) FROM minute_flow) AS latestTradeDate,
          (SELECT max(minute) FROM minute_flow WHERE trade_date = (SELECT max(trade_date) FROM minute_flow)) AS latestMinute,
          (SELECT max(collected_at) FROM minute_flow) AS lastCollectedAt
      `);
      const runs = await this.connection.runAndReadAll(`
        SELECT run_id AS runId, reason, started_at AS startedAt, finished_at AS finishedAt,
          status, boards_requested AS boardsRequested, boards_succeeded AS boardsSucceeded,
          rows_upserted AS rowsUpserted, error_message AS errorMessage
        FROM collector_runs ORDER BY started_at DESC LIMIT 1
      `);
      return { ...reader.getRowObjectsJson()[0], lastRun: runs.getRowObjectsJson()[0] || null };
    });
  }

  async close() {
    await this.queue.catch(() => undefined);
    this.connection.closeSync();
    this.instance.closeSync();
  }
}
