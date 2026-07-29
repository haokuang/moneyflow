import { fetchAshareIndexTurnoverKlines } from "./provider/market-turnover.mjs";

const YI = 100_000_000;
const METHOD = "近20日历史同期成交占比中位数 + 近期正式日成交额收缩";

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function groupByTradeDate(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const group = groups.get(row.tradeDate) || [];
    group.push(row);
    groups.set(row.tradeDate, group);
  });
  return groups;
}

function estimateComponent({
  currentRows,
  historicalRows,
  observedAt,
  minuteKey,
  officialPoints,
  officialKey,
}) {
  const observed = sum(currentRows, minuteKey);
  const ratios = historicalRows.flatMap((rows) => {
    const fullDay = sum(rows, minuteKey);
    if (fullDay <= 0) return [];
    const sameTime = sum(rows.filter((row) => row.minute <= observedAt), minuteKey);
    const ratio = sameTime / fullDay;
    return ratio > 0 && ratio <= 1.02 ? [Math.min(1, ratio)] : [];
  });
  const completionRatio = median(ratios);
  if (!completionRatio || observed <= 0) return null;

  const priorValues = officialPoints
    .filter((point) => !point.isEstimate && Number(point[officialKey]) > 0)
    .slice(-10)
    .map((point) => Number(point[officialKey]) * YI);
  const prior = median(priorValues);
  let raw = observed / completionRatio;
  if (prior) raw = clamp(raw, prior * 0.35, prior * 3);
  const observedWeight = clamp(0.2 + 0.8 * completionRatio, 0.25, 1);
  const estimated = prior
    ? observedWeight * raw + (1 - observedWeight) * prior
    : raw;

  return {
    observed,
    completionRatio,
    estimated: Math.max(observed, estimated),
    raw,
    prior,
    observedWeight,
  };
}

export function estimateIntradayMarketTurnover(rows, officialPoints, { profileDays = 20 } = {}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const grouped = groupByTradeDate(rows);
  const dates = [...grouped.keys()].sort();
  const tradeDate = dates[dates.length - 1];
  if (officialPoints.some((point) => point.tradeDate === tradeDate && !point.isEstimate && Number(point.total) > 0)) {
    return null;
  }

  const currentRows = grouped.get(tradeDate).sort((left, right) => left.minute.localeCompare(right.minute));
  const observedAt = currentRows[currentRows.length - 1]?.minute;
  if (!observedAt || observedAt < "10:00") return null;

  const historicalDates = dates
    .filter((date) => date < tradeDate && grouped.get(date).some((row) => row.minute === "15:00"))
    .slice(-profileDays);
  if (historicalDates.length < 5) return null;
  const historicalRows = historicalDates.map((date) => grouped.get(date));

  const shanghai = estimateComponent({
    currentRows,
    historicalRows,
    observedAt,
    minuteKey: "shanghaiTurnoverYuan",
    officialPoints,
    officialKey: "shanghai",
  });
  const shenzhen = estimateComponent({
    currentRows,
    historicalRows,
    observedAt,
    minuteKey: "shenzhenTurnoverYuan",
    officialPoints,
    officialKey: "shenzhen",
  });
  const total = estimateComponent({
    currentRows,
    historicalRows,
    observedAt,
    minuteKey: "totalTurnoverYuan",
    officialPoints,
    officialKey: "total",
  });
  if (!shanghai || !shenzhen || !total) return null;

  const shanghaiEstimateYuan = shanghai.estimated;
  const shenzhenEstimateYuan = shenzhen.estimated;
  const estimatedTotalYuan = shanghaiEstimateYuan + shenzhenEstimateYuan;
  const observedTotalYuan = total.observed;
  return {
    tradeDate,
    shanghai: Math.round((shanghaiEstimateYuan / YI) * 100) / 100,
    shenzhen: Math.round((shenzhenEstimateYuan / YI) * 100) / 100,
    total: Math.round((estimatedTotalYuan / YI) * 100) / 100,
    isEstimate: true,
    observedAt,
    observedTotal: Math.round((observedTotalYuan / YI) * 100) / 100,
    completionRatio: Math.round(total.completionRatio * 10_000) / 10_000,
    historyDays: historicalDates.length,
    method: METHOD,
    estimatedAt: new Date().toISOString(),
    sourceNote: "东方财富上证A股指数与深证A指5分钟成交额；收盘后以沪深交易所正式日值替换",
  };
}

export class MarketTurnoverEstimator {
  constructor({ refreshMs = 60_000, profileDays = 20 } = {}) {
    this.refreshMs = refreshMs;
    this.profileDays = profileDays;
    this.cachedRows = null;
    this.cachedAt = 0;
    this.pending = null;
    this.lastError = null;
  }

  async getRows() {
    if (this.cachedRows && Date.now() - this.cachedAt < this.refreshMs) return this.cachedRows;
    if (!this.pending) {
      this.pending = fetchAshareIndexTurnoverKlines()
        .then((rows) => {
          this.cachedRows = rows;
          this.cachedAt = Date.now();
          this.lastError = null;
          return rows;
        })
        .catch((error) => {
          this.lastError = error.message;
          throw error;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }

  async enhanceHistory(payload, limit = 30) {
    try {
      const rows = await this.getRows();
      const estimate = estimateIntradayMarketTurnover(rows, payload.points, { profileDays: this.profileDays });
      if (!estimate) return payload;
      const points = [...payload.points.filter((point) => point.tradeDate !== estimate.tradeDate), estimate]
        .sort((left, right) => left.tradeDate.localeCompare(right.tradeDate))
        .slice(-limit);
      return {
        meta: {
          ...payload.meta,
          count: points.length,
          latestTradeDate: estimate.tradeDate,
          isLatestEstimate: true,
          estimate: {
            observedAt: estimate.observedAt,
            observedTotal: estimate.observedTotal,
            completionRatio: estimate.completionRatio,
            historyDays: estimate.historyDays,
            method: estimate.method,
            estimatedAt: estimate.estimatedAt,
          },
        },
        points,
      };
    } catch (error) {
      return {
        ...payload,
        meta: { ...payload.meta, estimateError: error.message },
      };
    }
  }

  getStatus() {
    return {
      refreshMs: this.refreshMs,
      profileDays: this.profileDays,
      cachedAt: this.cachedAt ? new Date(this.cachedAt).toISOString() : null,
      lastError: this.lastError,
    };
  }
}
