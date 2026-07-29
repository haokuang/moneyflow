import crypto from "node:crypto";
import {
  marketTurnoverCollectIntervalMs,
  marketTurnoverDays,
  marketTurnoverEnabled,
  marketTurnoverFetchConcurrency,
  marketTurnoverStartupDelayMs,
} from "./config.mjs";
import { mapWithConcurrency } from "./provider/eastmoney.mjs";
import { fetchMarketTurnoverDay, fetchTradingDates } from "./provider/market-turnover.mjs";
import { MarketTurnoverEstimator } from "./market-turnover-estimator.mjs";

export class MarketTurnoverCollector {
  constructor(database) {
    this.database = database;
    this.running = false;
    this.timer = null;
    this.startupTimer = null;
    this.lastSummary = null;
    this.estimator = new MarketTurnoverEstimator();
  }

  async collect(reason = "manual") {
    if (!marketTurnoverEnabled) return { status: "disabled" };
    if (this.running) return { ...this.lastSummary, status: "running", message: "成交额采集任务已在运行" };
    this.running = true;
    const startedAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    const errors = [];
    let datesRequested = 0;
    let datesSucceeded = 0;
    let rowsUpserted = 0;

    try {
      const tradingDates = await fetchTradingDates(marketTurnoverDays);
      const storedDates = new Set(await this.database.getMarketTurnoverDates(marketTurnoverDays * 2));
      const latestDate = tradingDates[tradingDates.length - 1];
      const targetDates = tradingDates.filter((date) => !storedDates.has(date) || date === latestDate);
      datesRequested = targetDates.length;
      const results = await mapWithConcurrency(
        targetDates,
        marketTurnoverFetchConcurrency,
        (date) => fetchMarketTurnoverDay(date),
      );
      const rows = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          datesSucceeded += 1;
          rows.push(result.value);
        } else {
          errors.push(`${targetDates[index]}: ${result.reason.message}`);
        }
      });
      rowsUpserted = await this.database.upsertMarketTurnoverRows(rows);
      const status = rowsUpserted > 0 ? (errors.length ? "partial" : "success") : "failed";
      const summary = {
        runId,
        reason,
        startedAt,
        finishedAt: new Date().toISOString(),
        status,
        datesRequested,
        datesSucceeded,
        rowsUpserted,
        errorMessage: errors.length ? errors.slice(0, 8).join(" | ") : null,
      };
      await this.database.recordMarketTurnoverRun(summary);
      this.lastSummary = summary;
      console.log(`[turnover] ${status}: ${datesSucceeded}/${datesRequested} dates, ${rowsUpserted} rows`);
      return summary;
    } catch (error) {
      const summary = {
        runId,
        reason,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "failed",
        datesRequested,
        datesSucceeded,
        rowsUpserted,
        errorMessage: error.message,
      };
      await this.database.recordMarketTurnoverRun(summary);
      this.lastSummary = summary;
      throw error;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (!marketTurnoverEnabled || this.timer || this.startupTimer) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.collect("startup").catch((error) => {
        console.error(`[turnover] startup failed: ${error.message}`);
      });
    }, marketTurnoverStartupDelayMs);
    this.startupTimer.unref?.();
    this.timer = setInterval(() => {
      void this.collect("schedule").catch((error) => {
        console.error(`[turnover] schedule failed: ${error.message}`);
      });
    }, marketTurnoverCollectIntervalMs);
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
      enabled: marketTurnoverEnabled,
      running: this.running,
      intervalMs: marketTurnoverCollectIntervalMs,
      days: marketTurnoverDays,
      lastSummary: this.lastSummary,
      estimator: this.estimator.getStatus(),
    };
  }

  async getHistory(limit = 30) {
    const payload = await this.database.getMarketTurnoverHistory(limit);
    return this.estimator.enhanceHistory(payload, limit);
  }
}
