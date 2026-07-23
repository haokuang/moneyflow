import crypto from "node:crypto";
import { boardTypes, boardsPerSide, collectIntervalMs, fetchConcurrency, isTradingMinute } from "./config.mjs";
import { fetchBoardCandidates, fetchBoardMinuteFlow, mapWithConcurrency } from "./provider/eastmoney.mjs";

export class MoneyflowCollector {
  constructor(database) {
    this.database = database;
    this.running = false;
    this.timer = null;
    this.lastSummary = null;
  }

  async collect(reason = "manual") {
    if (this.running) return { ...this.lastSummary, status: "running", message: "采集任务已在运行" };
    this.running = true;
    const startedAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    let boardsRequested = 0;
    let boardsSucceeded = 0;
    let rowsUpserted = 0;
    const errors = [];

    try {
      for (const boardType of boardTypes) {
        let boards = [];
        try {
          boards = await fetchBoardCandidates(boardType, boardsPerSide);
          await this.database.upsertCatalog(boards);
        } catch (error) {
          errors.push(`${boardType}目录: ${error.message}`);
          boards = await this.database.getCachedCandidates(boardType, boardsPerSide * 2);
        }

        boardsRequested += boards.length;
        if (!boards.length) continue;
        const results = await mapWithConcurrency(boards, fetchConcurrency, async (board) => {
          const { rows, sourceHost } = await fetchBoardMinuteFlow(board);
          return rows.map((row) => ({ ...row, sourceHost }));
        });
        const rows = [];
        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            boardsSucceeded += 1;
            rows.push(...result.value);
          } else {
            errors.push(`${boards[index].name}: ${result.reason.message}`);
          }
        });
        rowsUpserted += await this.database.upsertMinuteRows(rows);
      }

      const status = rowsUpserted > 0 ? (errors.length ? "partial" : "success") : "failed";
      const summary = {
        runId,
        reason,
        startedAt,
        finishedAt: new Date().toISOString(),
        status,
        boardsRequested,
        boardsSucceeded,
        rowsUpserted,
        errorMessage: errors.length ? errors.slice(0, 8).join(" | ") : null,
      };
      await this.database.recordRun(summary);
      this.lastSummary = summary;
      console.log(`[collector] ${summary.status}: ${summary.boardsSucceeded}/${summary.boardsRequested} boards, ${summary.rowsUpserted} rows${summary.errorMessage ? ` · ${summary.errorMessage}` : ""}`);
      return summary;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    void this.collect("startup").catch((error) => {
      this.lastSummary = { status: "failed", errorMessage: error.message };
    });
    this.timer = setInterval(() => {
      if (!isTradingMinute()) return;
      void this.collect("schedule").catch((error) => {
        this.lastSummary = { status: "failed", errorMessage: error.message };
      });
    }, collectIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return { running: this.running, intervalMs: collectIntervalMs, lastSummary: this.lastSummary };
  }
}
