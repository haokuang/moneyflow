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

CREATE TABLE IF NOT EXISTS sector_constituent_snapshot (
  trade_date VARCHAR NOT NULL,
  snapshot_minute VARCHAR NOT NULL,
  board_type VARCHAR NOT NULL,
  board_code VARCHAR NOT NULL,
  board_name VARCHAR NOT NULL,
  stock_market VARCHAR NOT NULL,
  stock_code VARCHAR NOT NULL,
  stock_name VARCHAR NOT NULL,
  rank_by_main_flow INTEGER NOT NULL,
  snapshot_price DOUBLE NOT NULL,
  snapshot_change_pct DOUBLE NOT NULL,
  snapshot_main_flow_yuan DOUBLE NOT NULL,
  snapshot_main_flow_ratio DOUBLE NOT NULL,
  captured_at VARCHAR NOT NULL,
  source_host VARCHAR NOT NULL,
  PRIMARY KEY (
    trade_date,
    snapshot_minute,
    board_type,
    board_code,
    stock_market,
    stock_code
  )
);

CREATE TABLE IF NOT EXISTS stock_minute_flow (
  trade_date VARCHAR NOT NULL,
  market VARCHAR NOT NULL,
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
  PRIMARY KEY (trade_date, market, code, minute)
);

CREATE TABLE IF NOT EXISTS market_turnover_daily (
  trade_date VARCHAR PRIMARY KEY,
  shanghai_turnover_yuan DOUBLE NOT NULL,
  shenzhen_turnover_yuan DOUBLE NOT NULL,
  total_turnover_yuan DOUBLE NOT NULL,
  collected_at VARCHAR NOT NULL,
  source_note VARCHAR NOT NULL
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

CREATE TABLE IF NOT EXISTS stock_collector_runs (
  run_id VARCHAR PRIMARY KEY,
  reason VARCHAR NOT NULL,
  started_at VARCHAR NOT NULL,
  finished_at VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  boards_requested INTEGER NOT NULL,
  boards_succeeded INTEGER NOT NULL,
  stocks_requested INTEGER NOT NULL,
  stocks_succeeded INTEGER NOT NULL,
  constituents_upserted INTEGER NOT NULL,
  stock_rows_upserted INTEGER NOT NULL,
  error_message VARCHAR
);

CREATE TABLE IF NOT EXISTS market_turnover_runs (
  run_id VARCHAR PRIMARY KEY,
  reason VARCHAR NOT NULL,
  started_at VARCHAR NOT NULL,
  finished_at VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  dates_requested INTEGER NOT NULL,
  dates_succeeded INTEGER NOT NULL,
  rows_upserted INTEGER NOT NULL,
  error_message VARCHAR
);

CREATE TEMP TABLE IF NOT EXISTS catalog_stage AS SELECT * FROM sector_catalog WHERE false;
CREATE TEMP TABLE IF NOT EXISTS minute_flow_stage AS SELECT * FROM minute_flow WHERE false;
CREATE TEMP TABLE IF NOT EXISTS constituent_snapshot_stage AS
  SELECT * FROM sector_constituent_snapshot WHERE false;
CREATE TEMP TABLE IF NOT EXISTS stock_minute_flow_stage AS
  SELECT * FROM stock_minute_flow WHERE false;
CREATE TEMP TABLE IF NOT EXISTS market_turnover_stage AS
  SELECT * FROM market_turnover_daily WHERE false;

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

CREATE OR REPLACE VIEW stock_flow_5m AS
WITH normalized AS (
  SELECT
    *,
    substr(minute, 1, 3) || lpad(
      cast(cast(floor(cast(substr(minute, 4, 2) AS INTEGER) / 5) * 5 AS INTEGER) AS VARCHAR),
      2,
      '0'
    ) AS bucket
  FROM stock_minute_flow
)
SELECT
  trade_date,
  market,
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
GROUP BY trade_date, market, code, bucket;
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

  async upsertConstituentSnapshots(items) {
    if (!items.length) return 0;
    return this.enqueue(async () => {
      await this.connection.run("DELETE FROM constituent_snapshot_stage");
      const appender = await this.connection.createAppender("constituent_snapshot_stage");
      const timestamp = nowIso();
      for (const item of items) {
        appender.appendVarchar(item.tradeDate);
        appender.appendVarchar(item.snapshotMinute);
        appender.appendVarchar(item.boardType);
        appender.appendVarchar(item.boardCode);
        appender.appendVarchar(item.boardName);
        appender.appendVarchar(item.market);
        appender.appendVarchar(item.code);
        appender.appendVarchar(item.name);
        appender.appendInteger(item.rank);
        appender.appendDouble(item.snapshotPrice || 0);
        appender.appendDouble(item.snapshotChangePct || 0);
        appender.appendDouble(item.snapshotMainFlowYuan || 0);
        appender.appendDouble(item.snapshotMainFlowRatio || 0);
        appender.appendVarchar(item.capturedAt || timestamp);
        appender.appendVarchar(item.sourceHost || "unknown");
        appender.endRow();
      }
      appender.closeSync();
      await this.connection.run(`
        INSERT INTO sector_constituent_snapshot
        SELECT * FROM constituent_snapshot_stage
        ON CONFLICT (
          trade_date,
          snapshot_minute,
          board_type,
          board_code,
          stock_market,
          stock_code
        ) DO UPDATE SET
          board_name = excluded.board_name,
          stock_name = excluded.stock_name,
          rank_by_main_flow = excluded.rank_by_main_flow,
          snapshot_price = excluded.snapshot_price,
          snapshot_change_pct = excluded.snapshot_change_pct,
          snapshot_main_flow_yuan = excluded.snapshot_main_flow_yuan,
          snapshot_main_flow_ratio = excluded.snapshot_main_flow_ratio,
          captured_at = excluded.captured_at,
          source_host = excluded.source_host
      `);
      return items.length;
    });
  }

  async upsertStockMinuteRows(items) {
    if (!items.length) return 0;
    return this.enqueue(async () => {
      await this.connection.run("DELETE FROM stock_minute_flow_stage");
      const appender = await this.connection.createAppender("stock_minute_flow_stage");
      const collectedAt = nowIso();
      for (const item of items) {
        appender.appendVarchar(item.tradeDate);
        appender.appendVarchar(item.market);
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
        INSERT INTO stock_minute_flow SELECT * FROM stock_minute_flow_stage
        ON CONFLICT (trade_date, market, code, minute) DO UPDATE SET
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

  async upsertMarketTurnoverRows(items) {
    if (!items.length) return 0;
    return this.enqueue(async () => {
      await this.connection.run("DELETE FROM market_turnover_stage");
      const appender = await this.connection.createAppender("market_turnover_stage");
      const collectedAt = nowIso();
      for (const item of items) {
        appender.appendVarchar(item.tradeDate);
        appender.appendDouble(item.shanghaiTurnoverYuan);
        appender.appendDouble(item.shenzhenTurnoverYuan);
        appender.appendDouble(item.totalTurnoverYuan);
        appender.appendVarchar(collectedAt);
        appender.appendVarchar(item.sourceNote || "SSE/SZSE official daily overview");
        appender.endRow();
      }
      appender.closeSync();
      await this.connection.run(`
        INSERT INTO market_turnover_daily SELECT * FROM market_turnover_stage
        ON CONFLICT (trade_date) DO UPDATE SET
          shanghai_turnover_yuan = excluded.shanghai_turnover_yuan,
          shenzhen_turnover_yuan = excluded.shenzhen_turnover_yuan,
          total_turnover_yuan = excluded.total_turnover_yuan,
          collected_at = excluded.collected_at,
          source_note = excluded.source_note
      `);
      return items.length;
    });
  }

  async getLatestTradeDate(boardType) {
    return this.enqueue(async () => {
      const reader = await this.connection.runAndReadAll(
        "SELECT max(trade_date) AS tradeDate FROM minute_flow WHERE board_type = $boardType",
        { boardType },
      );
      return reader.getRowObjectsJson()[0]?.tradeDate || null;
    });
  }

  async getCachedConstituents(boardType, boardCode, limit = 5) {
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 5));
    return this.enqueue(async () => {
      const reader = await this.connection.runAndReadAll(`
        SELECT
          board_type AS boardType,
          board_code AS boardCode,
          board_name AS boardName,
          stock_market AS market,
          stock_code AS code,
          stock_name AS name,
          rank_by_main_flow AS rank,
          snapshot_price AS snapshotPrice,
          snapshot_change_pct AS snapshotChangePct,
          snapshot_main_flow_yuan AS snapshotMainFlowYuan,
          snapshot_main_flow_ratio AS snapshotMainFlowRatio,
          source_host AS sourceHost
        FROM sector_constituent_snapshot
        WHERE board_type = $boardType
          AND board_code = $boardCode
          AND captured_at = (
            SELECT max(captured_at)
            FROM sector_constituent_snapshot
            WHERE board_type = $boardType AND board_code = $boardCode
          )
        ORDER BY rank_by_main_flow, stock_code
        LIMIT $limit
      `, { boardType, boardCode, limit: safeLimit });
      return reader.getRowObjectsJson();
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

  async recordStockRun(run) {
    return this.enqueue(() => this.connection.run(`
      INSERT OR REPLACE INTO stock_collector_runs VALUES (
        $runId, $reason, $startedAt, $finishedAt, $status,
        $boardsRequested, $boardsSucceeded, $stocksRequested, $stocksSucceeded,
        $constituentsUpserted, $stockRowsUpserted, $errorMessage
      )
    `, run));
  }

  async recordMarketTurnoverRun(run) {
    return this.enqueue(() => this.connection.run(`
      INSERT OR REPLACE INTO market_turnover_runs VALUES (
        $runId, $reason, $startedAt, $finishedAt, $status,
        $datesRequested, $datesSucceeded, $rowsUpserted, $errorMessage
      )
    `, run));
  }

  async getMarketTurnoverDates(limit = 60) {
    const safeLimit = Math.min(365, Math.max(1, Number(limit) || 60));
    return this.enqueue(async () => {
      const reader = await this.connection.runAndReadAll(`
        SELECT trade_date AS tradeDate
        FROM market_turnover_daily
        WHERE total_turnover_yuan > 0
        ORDER BY trade_date DESC
        LIMIT $limit
      `, { limit: safeLimit });
      return reader.getRowObjectsJson().map((row) => row.tradeDate);
    });
  }

  async getMarketTurnoverHistory(limit = 30) {
    const safeLimit = Math.min(120, Math.max(5, Number(limit) || 30));
    return this.enqueue(async () => {
      const reader = await this.connection.runAndReadAll(`
        SELECT * FROM (
          SELECT
            trade_date AS tradeDate,
            round(shanghai_turnover_yuan / 100000000.0, 2) AS shanghai,
            round(shenzhen_turnover_yuan / 100000000.0, 2) AS shenzhen,
            round(total_turnover_yuan / 100000000.0, 2) AS total,
            collected_at AS collectedAt,
            source_note AS sourceNote
          FROM market_turnover_daily
          WHERE total_turnover_yuan > 0
          ORDER BY trade_date DESC
          LIMIT $limit
        )
        ORDER BY tradeDate
      `, { limit: safeLimit });
      const points = reader.getRowObjectsJson();
      const latest = points[points.length - 1] || null;
      return {
        meta: {
          count: points.length,
          latestTradeDate: latest?.tradeDate || null,
          collectedAt: latest?.collectedAt || null,
          unit: "亿元",
          scope: "上交所主板A股+科创板，深交所主板A股+创业板",
        },
        points,
      };
    });
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

  async getSectorStockLeaders({
    boardType,
    boardCode,
    tradeDate = "latest",
    flowType = "main",
    direction = "inflow",
    limit = 5,
  }) {
    const field = FLOW_FIELDS[flowType] || FLOW_FIELDS.main;
    const safeDirection = direction === "outflow" ? "outflow" : "inflow";
    const snapshotFallback = field === FLOW_FIELDS.main
      ? "snapshot.snapshot_main_flow_yuan / 100000000.0"
      : "NULL";
    const directionFilter = safeDirection === "outflow" ? "< 0" : "> 0";
    const directionOrder = safeDirection === "outflow" ? "ASC" : "DESC";
    const safeLimit = Math.min(20, Math.max(1, Number(limit) || 5));
    return this.enqueue(async () => {
      let selectedDate = tradeDate;
      if (!selectedDate || selectedDate === "latest") {
        const dateReader = await this.connection.runAndReadAll(`
          SELECT max(trade_date) AS tradeDate
          FROM sector_constituent_snapshot
          WHERE board_type = $boardType AND board_code = $boardCode
        `, { boardType, boardCode });
        selectedDate = dateReader.getRowObjectsJson()[0]?.tradeDate || null;
      }
      if (!selectedDate) {
        return {
          meta: { boardType, boardCode, tradeDate: null, snapshotMinute: null, latestMinute: null, direction: safeDirection },
          stocks: [],
        };
      }

      const snapshotReader = await this.connection.runAndReadAll(`
        SELECT max(snapshot_minute) AS snapshotMinute
        FROM sector_constituent_snapshot
        WHERE trade_date = $tradeDate
          AND board_type = $boardType
          AND board_code = $boardCode
      `, { tradeDate: selectedDate, boardType, boardCode });
      const snapshotMinute = snapshotReader.getRowObjectsJson()[0]?.snapshotMinute || null;
      if (!snapshotMinute) {
        return {
          meta: { boardType, boardCode, tradeDate: selectedDate, snapshotMinute: null, latestMinute: null, direction: safeDirection },
          stocks: [],
        };
      }

      const reader = await this.connection.runAndReadAll(`
        WITH snapshot AS (
          SELECT *
          FROM sector_constituent_snapshot
          WHERE trade_date = $tradeDate
            AND snapshot_minute = $snapshotMinute
            AND board_type = $boardType
            AND board_code = $boardCode
        ), latest_flow AS (
          SELECT
            market,
            code,
            arg_max(name, minute) AS name,
            max(minute) AS latest_minute,
            arg_max(${field}, minute) / 100000000.0 AS selected_flow,
            arg_max(main_flow_yuan, minute) / 100000000.0 AS main,
            arg_max(small_flow_yuan, minute) / 100000000.0 AS small,
            arg_max(medium_flow_yuan, minute) / 100000000.0 AS medium,
            arg_max(large_flow_yuan, minute) / 100000000.0 AS large,
            arg_max(super_flow_yuan, minute) / 100000000.0 AS super
          FROM stock_minute_flow
          WHERE trade_date = $tradeDate
          GROUP BY market, code
        ), joined AS (
        SELECT
          snapshot.board_name AS boardName,
          snapshot.rank_by_main_flow AS rank,
          snapshot.stock_market AS market,
          snapshot.stock_code AS code,
          coalesce(latest_flow.name, snapshot.stock_name) AS name,
          snapshot.snapshot_price AS price,
          snapshot.snapshot_change_pct AS changePct,
          snapshot.snapshot_main_flow_yuan / 100000000.0 AS snapshotMain,
          snapshot.snapshot_main_flow_ratio AS snapshotMainRatio,
          coalesce(latest_flow.selected_flow, ${snapshotFallback}) AS selectedFlow,
          latest_flow.main,
          latest_flow.small,
          latest_flow.medium,
          latest_flow.large,
          latest_flow.super,
          latest_flow.latest_minute AS latestMinute
        FROM snapshot
        LEFT JOIN latest_flow
          ON latest_flow.market = snapshot.stock_market
          AND latest_flow.code = snapshot.stock_code
        )
        SELECT * FROM joined
        WHERE selectedFlow ${directionFilter}
        ORDER BY selectedFlow ${directionOrder} NULLS LAST, rank, code
        LIMIT $limit
      `, {
        tradeDate: selectedDate,
        snapshotMinute,
        boardType,
        boardCode,
        limit: safeLimit,
      });
      const stocks = reader.getRowObjectsJson();
      const latestMinute = stocks.reduce(
        (latest, stock) => stock.latestMinute > latest ? stock.latestMinute : latest,
        "",
      );
      return {
        meta: {
          boardType,
          boardCode,
          boardName: stocks[0]?.boardName || null,
          tradeDate: selectedDate,
          snapshotMinute,
          latestMinute: latestMinute || null,
          flowType: FLOW_FIELDS[flowType] ? flowType : "main",
          direction: safeDirection,
        },
        stocks,
      };
    });
  }

  async getStatus() {
    return this.enqueue(async () => {
      const reader = await this.connection.runAndReadAll(`
        SELECT
          cast((SELECT count(*) FROM sector_catalog) AS INTEGER) AS sectorCount,
          cast((SELECT count(*) FROM minute_flow) AS INTEGER) AS minuteRowCount,
          cast((SELECT count(*) FROM sector_constituent_snapshot) AS INTEGER) AS constituentSnapshotCount,
          cast((SELECT count(*) FROM stock_minute_flow) AS INTEGER) AS stockMinuteRowCount,
          cast((SELECT count(DISTINCT market || ':' || code) FROM stock_minute_flow) AS INTEGER) AS stockCount,
          cast((SELECT count(*) FROM market_turnover_daily WHERE total_turnover_yuan > 0) AS INTEGER) AS marketTurnoverDayCount,
          (SELECT max(trade_date) FROM minute_flow) AS latestTradeDate,
          (SELECT max(minute) FROM minute_flow WHERE trade_date = (SELECT max(trade_date) FROM minute_flow)) AS latestMinute,
          (SELECT max(trade_date) FROM stock_minute_flow) AS latestStockTradeDate,
          (SELECT max(minute) FROM stock_minute_flow
            WHERE trade_date = (SELECT max(trade_date) FROM stock_minute_flow)) AS latestStockMinute,
          (SELECT max(trade_date) FROM market_turnover_daily WHERE total_turnover_yuan > 0) AS latestMarketTurnoverDate,
          (SELECT max(collected_at) FROM minute_flow) AS lastCollectedAt
      `);
      const runs = await this.connection.runAndReadAll(`
        SELECT run_id AS runId, reason, started_at AS startedAt, finished_at AS finishedAt,
          status, boards_requested AS boardsRequested, boards_succeeded AS boardsSucceeded,
          rows_upserted AS rowsUpserted, error_message AS errorMessage
        FROM collector_runs ORDER BY started_at DESC LIMIT 1
      `);
      const stockRuns = await this.connection.runAndReadAll(`
        SELECT
          run_id AS runId,
          reason,
          started_at AS startedAt,
          finished_at AS finishedAt,
          status,
          boards_requested AS boardsRequested,
          boards_succeeded AS boardsSucceeded,
          stocks_requested AS stocksRequested,
          stocks_succeeded AS stocksSucceeded,
          constituents_upserted AS constituentsUpserted,
          stock_rows_upserted AS stockRowsUpserted,
          error_message AS errorMessage
        FROM stock_collector_runs
        ORDER BY started_at DESC
        LIMIT 1
      `);
      const turnoverRuns = await this.connection.runAndReadAll(`
        SELECT
          run_id AS runId,
          reason,
          started_at AS startedAt,
          finished_at AS finishedAt,
          status,
          dates_requested AS datesRequested,
          dates_succeeded AS datesSucceeded,
          rows_upserted AS rowsUpserted,
          error_message AS errorMessage
        FROM market_turnover_runs
        ORDER BY started_at DESC
        LIMIT 1
      `);
      return {
        ...reader.getRowObjectsJson()[0],
        lastRun: runs.getRowObjectsJson()[0] || null,
        lastStockRun: stockRuns.getRowObjectsJson()[0] || null,
        lastMarketTurnoverRun: turnoverRuns.getRowObjectsJson()[0] || null,
      };
    });
  }

  async close() {
    await this.queue.catch(() => undefined);
    this.connection.closeSync();
    this.instance.closeSync();
  }
}
