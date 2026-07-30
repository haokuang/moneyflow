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

function sumProfile(rows, profileKey, fallbackKey) {
  const hasProfile = rows.some((row) => Number.isFinite(Number(row[profileKey])));
  return sum(rows, hasProfile ? profileKey : fallbackKey);
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
  profileKey,
  officialPoints,
  officialKey,
}) {
  const observed = sum(currentRows, minuteKey);
  const ratios = historicalRows.flatMap((rows) => {
    const fullDay = sumProfile(rows, profileKey, minuteKey);
    if (fullDay <= 0) return [];
    const sameTime = sumProfile(rows.filter((row) => row.minute <= observedAt), profileKey, minuteKey);
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
  const profileBasis = currentRows[currentRows.length - 1]?.estimateProfile === "volume-proxy"
    ? "volume-proxy"
    : "turnover";

  const shanghai = estimateComponent({
    currentRows,
    historicalRows,
    observedAt,
    minuteKey: "shanghaiTurnoverYuan",
    profileKey: "shanghaiProfileValue",
    officialPoints,
    officialKey: "shanghai",
  });
  const shenzhen = estimateComponent({
    currentRows,
    historicalRows,
    observedAt,
    minuteKey: "shenzhenTurnoverYuan",
    profileKey: "shenzhenProfileValue",
    officialPoints,
    officialKey: "shenzhen",
  });
  const total = estimateComponent({
    currentRows,
    historicalRows,
    observedAt,
    minuteKey: "totalTurnoverYuan",
    profileKey: "totalProfileValue",
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
    method: profileBasis === "volume-proxy"
      ? `近${historicalDates.length}日A股指数历史同期成交量占比中位数（成交额完成度代理）+ 近期正式日成交额收缩`
      : METHOD,
    profileBasis,
    estimatedAt: new Date().toISOString(),
    sourceNote: currentRows[currentRows.length - 1]?.estimateSourceNote
      || "东方财富上证A股指数与深证A指5分钟成交额；收盘后以沪深交易所正式日值替换",
  };
}

export class MarketTurnoverEstimator {
  constructor({
    refreshMs = 60_000,
    profileDays = 20,
    maxStaleMs = 300_000,
    fetchRows = fetchAshareIndexTurnoverKlines,
    now = () => Date.now(),
  } = {}) {
    this.refreshMs = refreshMs;
    this.profileDays = profileDays;
    this.maxStaleMs = maxStaleMs;
    this.fetchRows = fetchRows;
    this.now = now;
    this.cachedRows = null;
    this.cachedAt = 0;
    this.pending = null;
    this.lastError = null;
    this.lastServedStale = false;
  }

  async getRows() {
    const cacheAgeMs = this.cachedRows ? this.now() - this.cachedAt : null;
    if (this.cachedRows && cacheAgeMs < this.refreshMs) {
      this.lastServedStale = false;
      return { rows: this.cachedRows, stale: false, cachedAt: this.cachedAt, cacheAgeMs };
    }
    if (!this.pending) {
      this.pending = this.fetchRows()
        .then((rows) => {
          this.cachedRows = rows;
          this.cachedAt = this.now();
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
    try {
      const rows = await this.pending;
      this.lastServedStale = false;
      return { rows, stale: false, cachedAt: this.cachedAt, cacheAgeMs: 0 };
    } catch (error) {
      const failedCacheAgeMs = this.cachedRows ? this.now() - this.cachedAt : null;
      if (this.cachedRows && failedCacheAgeMs <= this.maxStaleMs) {
        this.lastServedStale = true;
        return {
          rows: this.cachedRows,
          stale: true,
          cachedAt: this.cachedAt,
          cacheAgeMs: failedCacheAgeMs,
          error: error.message,
        };
      }
      this.lastServedStale = false;
      throw error;
    }
  }

  async enhanceHistory(payload, limit = 30) {
    try {
      const source = await this.getRows();
      const rows = source.rows;
      const estimate = estimateIntradayMarketTurnover(rows, payload.points, { profileDays: this.profileDays });
      if (!estimate) return payload;
      const sourceCachedAt = new Date(source.cachedAt).toISOString();
      const sourceAgeSeconds = Math.max(0, Math.round(source.cacheAgeMs / 1000));
      const enrichedEstimate = {
        ...estimate,
        isStaleEstimate: source.stale,
        sourceCachedAt,
        sourceAgeSeconds,
        sourceError: source.error || null,
      };
      const points = [...payload.points.filter((point) => point.tradeDate !== estimate.tradeDate), enrichedEstimate]
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
            profileBasis: estimate.profileBasis,
            sourceNote: estimate.sourceNote,
            estimatedAt: estimate.estimatedAt,
            isStale: source.stale,
            sourceCachedAt,
            sourceAgeSeconds,
            sourceError: source.error || null,
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
      maxStaleMs: this.maxStaleMs,
      cachedAt: this.cachedAt ? new Date(this.cachedAt).toISOString() : null,
      cacheAgeMs: this.cachedAt ? Math.max(0, this.now() - this.cachedAt) : null,
      lastServedStale: this.lastServedStale,
      lastError: this.lastError,
    };
  }
}
