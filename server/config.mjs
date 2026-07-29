import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(serverDir, "..");
export const dataDir = path.resolve(process.env.MONEYFLOW_DATA_DIR || path.join(projectRoot, "data"));
export const databasePath = path.resolve(process.env.MONEYFLOW_DB_PATH || path.join(dataDir, "moneyflow.duckdb"));
export const port = Number(process.env.PORT || 4173);
export const host = process.env.HOST || "0.0.0.0";
export const collectIntervalMs = Math.max(10_000, Number(process.env.COLLECT_INTERVAL_MS || 60_000));
export const boardsPerSide = Math.min(60, Math.max(3, Number(process.env.BOARDS_PER_SIDE || 15)));
export const fetchConcurrency = Math.min(12, Math.max(1, Number(process.env.FETCH_CONCURRENCY || 6)));
export const requestTimeoutMs = Math.min(30_000, Math.max(2_000, Number(process.env.REQUEST_TIMEOUT_MS || 10_000)));
export const boardTypes = (process.env.BOARD_TYPES || "industry,concept")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value === "industry" || value === "concept");
export const stockHistoryEnabled = process.env.STOCK_HISTORY_ENABLED !== "0";
export const stockCollectIntervalMs = Math.max(
  60_000,
  Number(process.env.STOCK_COLLECT_INTERVAL_MS || 300_000),
);
export const stockStartupDelayMs = Math.max(
  0,
  Number(process.env.STOCK_STARTUP_DELAY_MS || 15_000),
);
export const stockBoardsPerType = Math.min(
  60,
  Math.max(1, Number(process.env.STOCK_BOARDS_PER_TYPE || boardsPerSide * 2)),
);
export const stocksPerBoard = Math.min(
  20,
  Math.max(1, Number(process.env.STOCKS_PER_BOARD || 5)),
);
export const stockFetchConcurrency = Math.min(
  12,
  Math.max(1, Number(process.env.STOCK_FETCH_CONCURRENCY || 4)),
);
export const stockBoardTypes = (process.env.STOCK_BOARD_TYPES || "industry")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value === "industry" || value === "concept");
export const marketTurnoverEnabled = process.env.MARKET_TURNOVER_ENABLED !== "0";
export const marketTurnoverCollectIntervalMs = Math.max(
  60_000,
  Number(process.env.MARKET_TURNOVER_COLLECT_INTERVAL_MS || 600_000),
);
export const marketTurnoverStartupDelayMs = Math.max(
  0,
  Number(process.env.MARKET_TURNOVER_STARTUP_DELAY_MS || 5_000),
);
export const marketTurnoverDays = Math.min(
  120,
  Math.max(5, Number(process.env.MARKET_TURNOVER_DAYS || 30)),
);
export const marketTurnoverFetchConcurrency = Math.min(
  8,
  Math.max(1, Number(process.env.MARKET_TURNOVER_FETCH_CONCURRENCY || 4)),
);

export function shanghaiClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: values.weekday,
    tradeDate: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

export function isTradingMinute(date = new Date()) {
  if (process.env.FORCE_COLLECT === "1") return true;
  const clock = shanghaiClock(date);
  if (clock.weekday === "Sat" || clock.weekday === "Sun") return false;
  return (clock.minutes >= 570 && clock.minutes <= 690) || (clock.minutes >= 780 && clock.minutes <= 900);
}
