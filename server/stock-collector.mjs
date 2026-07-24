import crypto from "node:crypto";
import {
  isTradingMinute,
  shanghaiClock,
  stockBoardTypes,
  stockBoardsPerType,
  stockCollectIntervalMs,
  stockFetchConcurrency,
  stockHistoryEnabled,
  stocksPerBoard,
  stockStartupDelayMs,
} from "./config.mjs";
import {
  fetchBoardCandidates,
  fetchSectorConstituents,
  fetchStockMinuteFlow,
  mapWithConcurrency,
} from "./provider/eastmoney.mjs";

function stockKey(stock) {
  return `${stock.market}:${stock.code}`;
}

export class StockHistoryCollector {
  constructor(database) {
    this.database = database;
    this.running = false;
    this.timer = null;
    this.startupTimer = null;
    this.lastSummary = null;
  }

  async collect(reason = "manual") {
    if (!stockHistoryEnabled) return { status: "disabled", message: "个股历史采集已禁用" };
    if (this.running) return { ...this.lastSummary, status: "running", message: "个股采集任务已在运行" };

    this.running = true;
    const startedAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    const clock = shanghaiClock();
    const snapshotMinute = clock.time.slice(0, 5);
    let boardsRequested = 0;
    let boardsSucceeded = 0;
    let stocksRequested = 0;
    let stocksSucceeded = 0;
    let constituentsUpserted = 0;
    let stockRowsUpserted = 0;
    const errors = [];

    try {
      const fallbackDates = new Map();
      const boards = [];
      for (const boardType of stockBoardTypes) {
        fallbackDates.set(boardType, await this.database.getLatestTradeDate(boardType));
        let candidates = await this.database.getCachedCandidates(boardType, stockBoardsPerType);
        if (!candidates.length) {
          try {
            candidates = await fetchBoardCandidates(
              boardType,
              Math.max(1, Math.ceil(stockBoardsPerType / 2)),
            );
            await this.database.upsertCatalog(candidates);
          } catch (error) {
            errors.push(`${boardType}目录: ${error.message}`);
          }
        }
        boards.push(...candidates.slice(0, stockBoardsPerType));
      }

      boardsRequested = boards.length;
      const constituentResults = await mapWithConcurrency(
        boards,
        Math.min(4, stockFetchConcurrency),
        async (board) => {
          try {
            return await fetchSectorConstituents(board, stocksPerBoard);
          } catch (error) {
            const cached = await this.database.getCachedConstituents(
              board.boardType,
              board.code,
              stocksPerBoard,
            );
            if (!cached.length) throw error;
            return {
              items: cached,
              sourceHost: cached[0].sourceHost || "duckdb-cache",
              cacheFallback: true,
              upstreamError: error.message,
            };
          }
        },
      );

      const constituentItems = [];
      constituentResults.forEach((result, index) => {
        if (result.status === "fulfilled") {
          boardsSucceeded += 1;
          if (result.value.cacheFallback) {
            errors.push(`${boards[index].name}成分股使用缓存: ${result.value.upstreamError}`);
          }
          constituentItems.push(...result.value.items.map((item) => ({
            ...item,
            capturedAt: startedAt,
            snapshotMinute,
            sourceHost: result.value.sourceHost,
          })));
        } else {
          errors.push(`${boards[index].name}成分股: ${result.reason.message}`);
        }
      });

      const uniqueStocks = [...new Map(constituentItems.map((item) => [
        stockKey(item),
        { market: item.market, code: item.code, name: item.name },
      ])).values()];
      stocksRequested = uniqueStocks.length;
      const stockResults = await mapWithConcurrency(
        uniqueStocks,
        stockFetchConcurrency,
        async (stock) => {
          const { rows, sourceHost } = await fetchStockMinuteFlow(stock);
          return rows.map((row) => ({ ...row, sourceHost }));
        },
      );

      const stockRows = [];
      stockResults.forEach((result, index) => {
        if (result.status === "fulfilled") {
          stocksSucceeded += 1;
          stockRows.push(...result.value);
        } else {
          errors.push(`${uniqueStocks[index].name}分钟资金: ${result.reason.message}`);
        }
      });

      const tradeDateByStock = new Map();
      for (const row of stockRows) {
        const key = stockKey(row);
        const current = tradeDateByStock.get(key);
        if (!current || row.tradeDate > current) tradeDateByStock.set(key, row.tradeDate);
      }
      const snapshots = constituentItems.map((item) => ({
        ...item,
        tradeDate: tradeDateByStock.get(stockKey(item))
          || fallbackDates.get(item.boardType)
          || clock.tradeDate,
      }));

      stockRowsUpserted = await this.database.upsertStockMinuteRows(stockRows);
      constituentsUpserted = await this.database.upsertConstituentSnapshots(snapshots);

      const wroteData = stockRowsUpserted > 0 || constituentsUpserted > 0;
      const status = wroteData ? (errors.length ? "partial" : "success") : "failed";
      const summary = {
        runId,
        reason,
        startedAt,
        finishedAt: new Date().toISOString(),
        status,
        boardsRequested,
        boardsSucceeded,
        stocksRequested,
        stocksSucceeded,
        constituentsUpserted,
        stockRowsUpserted,
        errorMessage: errors.length ? errors.slice(0, 12).join(" | ") : null,
      };
      await this.database.recordStockRun(summary);
      this.lastSummary = summary;
      console.log(
        `[stock-collector] ${summary.status}: `
        + `${summary.boardsSucceeded}/${summary.boardsRequested} boards, `
        + `${summary.stocksSucceeded}/${summary.stocksRequested} stocks, `
        + `${summary.stockRowsUpserted} minute rows`,
      );
      return summary;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (!stockHistoryEnabled || this.timer || this.startupTimer) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.collect("startup").catch((error) => {
        this.lastSummary = { status: "failed", errorMessage: error.message };
      });
    }, stockStartupDelayMs);
    this.startupTimer.unref?.();
    this.timer = setInterval(() => {
      if (!isTradingMinute()) return;
      void this.collect("schedule").catch((error) => {
        this.lastSummary = { status: "failed", errorMessage: error.message };
      });
    }, stockCollectIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
  }

  getStatus() {
    return {
      enabled: stockHistoryEnabled,
      running: this.running,
      intervalMs: stockCollectIntervalMs,
      boardsPerType: stockBoardsPerType,
      stocksPerBoard,
      boardTypes: stockBoardTypes,
      lastSummary: this.lastSummary,
    };
  }
}
