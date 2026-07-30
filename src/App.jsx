import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const INDUSTRY_NAMES = [
  "电池",
  "光学光电子",
  "元件",
  "半导体",
  "保险",
  "乘用车",
  "炼化及贸易",
  "医疗器械",
  "油气开采",
  "煤炭开采",
  "白色家电",
  "工业金属",
  "通信服务",
  "航运港口",
  "软件开发",
  "专用设备",
  "电网设备",
  "消费电子",
  "光伏设备",
  "计算机设备",
  "通用设备",
  "化学制品",
  "白酒",
  "自动化设备",
  "证券",
  "化学制药",
  "汽车零部件",
  "电力",
  "IT服务",
  "通信设备",
];

const CONCEPT_NAMES = [
  "固态电池",
  "AI芯片",
  "人形机器人",
  "光通信模块",
  "商业航天",
  "低空经济",
  "液冷概念",
  "国产软件",
  "机器人执行器",
  "算力概念",
  "先进封装",
  "铜缆高速连接",
  "半导体概念",
  "华为昇腾",
  "新能源汽车",
  "创新药",
  "稀土永磁",
  "消费电子概念",
  "数据要素",
  "军工",
  "储能概念",
  "CPO概念",
  "无人驾驶",
  "黄金概念",
];

const FLOW_TYPES = {
  main: { label: "主力", fieldIndex: 1 },
  super: { label: "超大单", fieldIndex: 5 },
  large: { label: "大单", fieldIndex: 4 },
  medium: { label: "中单", fieldIndex: 3 },
  small: { label: "小单", fieldIndex: 2 },
};

const PERIOD_LABELS = {
  "full-day": "全日",
  morning: "上午",
  afternoon: "下午",
};

const TRADING_TIME_TICKS = {
  "full-day": ["09:30", "10:00", "10:30", "11:00", "11:30", "13:00", "13:30", "14:00", "14:30", "15:00"],
  morning: ["09:30", "10:00", "10:30", "11:00", "11:30"],
  afternoon: ["13:00", "13:30", "14:00", "14:30", "15:00"],
};

const MORNING_START = 9 * 60 + 30;
const MORNING_END = 11 * 60 + 30;
const AFTERNOON_START = 13 * 60;
const AFTERNOON_END = 15 * 60;
const LUNCH_GAP_WIDTH = 42;

const INTERVAL_LABELS = {
  "1m": "1 分钟",
  "5m": "5 分钟",
};

function createTradingTimes(interval) {
  const stepMinutes = interval === "1m" ? 1 : 5;
  const times = [];
  const append = (startHour, startMinute, endHour, endMinute) => {
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    for (let total = start; total <= end; total += stepMinutes) {
      times.push(
        `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`,
      );
    }
  };
  append(9, 30, 11, 30);
  append(13, 0, 15, 0);
  return times;
}

function seededNoise(seed) {
  let value = seed % 2147483647;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

function stringSeed(value) {
  return [...value].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
}

function makeDemoSeries(boardType, interval) {
  const names = boardType === "industry" ? INDUSTRY_NAMES : CONCEPT_NAMES;
  const times = createTradingTimes(interval);
  const stepScale = interval === "1m" ? 0.2 : 1;
  return names.map((name, index) => {
    const random = seededNoise(stringSeed(`${boardType}-${name}`));
    const direction = index < 7 ? 1 : index > names.length - 9 ? -1 : random() > 0.58 ? 1 : -1;
    const magnitude = 0.4 + Math.pow(index < 7 ? 8 - index : index / names.length, 1.35) * 1.8;
    let main = 0;
    const points = times.map((time, pointIndex) => {
      const normalizedIndex = pointIndex * stepScale;
      const openPulse = normalizedIndex < 8 ? 1.6 : normalizedIndex > 30 ? 0.72 : 1;
      const drift = direction * magnitude * openPulse * (0.08 + random() * 0.27) * stepScale;
      const reversal = Math.sin(normalizedIndex / 5 + index * 0.7) * magnitude * 0.08 * stepScale;
      main += drift + reversal + (random() - 0.5) * magnitude * 0.16 * stepScale;
      const superFlow = main * (0.44 + random() * 0.08);
      const largeFlow = main - superFlow;
      const mediumFlow = -main * (0.24 + random() * 0.12);
      const smallFlow = -main - mediumFlow;
      return {
        time,
        main: Number(main.toFixed(2)),
        super: Number(superFlow.toFixed(2)),
        large: Number(largeFlow.toFixed(2)),
        medium: Number(mediumFlow.toFixed(2)),
        small: Number(smallFlow.toFixed(2)),
      };
    });
    return { code: `DEMO${index + 1}`, name, points };
  });
}

function formatYi(value, signed = false) {
  if (!Number.isFinite(value)) return "--";
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}亿`;
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatTurnoverYi(value) {
  if (!Number.isFinite(value)) return "--";
  return value >= 10_000 ? `${(value / 10_000).toFixed(2)}万亿` : `${value.toFixed(0)}亿`;
}

function formatShortDate(value) {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(value || "");
  return match ? `${Number(match[1])}/${Number(match[2])}` : value;
}

function formatTradeDateLabel(tradeDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradeDate || "");
  if (match) return `${Number(match[2])}月${Number(match[3])}日`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date());
}

function filterPoints(points, period) {
  if (period === "morning") return points.filter((point) => point.time < "12:00");
  if (period === "afternoon") return points.filter((point) => point.time >= "12:00");
  return points;
}

function clockMinutes(time) {
  const [hour, minute] = String(time || "").split(":").map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : MORNING_START;
}

function tradingTimeX(time, period, left, width) {
  const minute = clockMinutes(time);
  if (period === "morning") {
    const progress = Math.min(1, Math.max(0, (minute - MORNING_START) / (MORNING_END - MORNING_START)));
    return left + progress * width;
  }
  if (period === "afternoon") {
    const progress = Math.min(1, Math.max(0, (minute - AFTERNOON_START) / (AFTERNOON_END - AFTERNOON_START)));
    return left + progress * width;
  }

  const sessionWidth = (width - LUNCH_GAP_WIDTH) / 2;
  if (minute <= MORNING_END) {
    const progress = Math.min(1, Math.max(0, (minute - MORNING_START) / (MORNING_END - MORNING_START)));
    return left + progress * sessionWidth;
  }
  const progress = Math.min(1, Math.max(0, (minute - AFTERNOON_START) / (AFTERNOON_END - AFTERNOON_START)));
  return left + sessionWidth + LUNCH_GAP_WIDTH + progress * sessionWidth;
}

function distributeLabels(items, minY, maxY, gap) {
  const sorted = [...items].sort((a, b) => a.rawY - b.rawY);
  sorted.forEach((item, index) => {
    item.labelY = Math.max(item.rawY, index === 0 ? minY : sorted[index - 1].labelY + gap);
  });
  if (sorted.length && sorted[sorted.length - 1].labelY > maxY) {
    const shift = sorted[sorted.length - 1].labelY - maxY;
    sorted.forEach((item) => {
      item.labelY -= shift;
    });
    for (let index = sorted.length - 2; index >= 0; index -= 1) {
      sorted[index].labelY = Math.min(sorted[index].labelY, sorted[index + 1].labelY - gap);
    }
  }
  return sorted;
}

function FlowChart({
  series,
  flowType,
  interval,
  period,
  activeName,
  pinnedName,
  onHoverName,
  onPinnedName,
}) {
  const width = 1180;
  const height = 600;
  const margin = { top: 26, right: 326, bottom: 54, left: 66 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const visible = series
    .map((item) => ({ ...item, points: filterPoints(item.points, period) }))
    .filter((item) => item.points.length);
  const values = visible.flatMap((item) => item.points.map((point) => point[flowType]));
  const bound = Math.max(4, ...values.map((value) => Math.abs(value))) * 1.12;
  const x = (time) => tradingTimeX(time, period, margin.left, plotWidth);
  const y = (value) => margin.top + ((bound - value) / (bound * 2)) * plotHeight;
  const latest = visible.map((item) => {
    const value = item.points[item.points.length - 1][flowType];
    return { ...item, value, rawY: y(value) };
  });
  const labels = distributeLabels(latest, margin.top + 6, margin.top + plotHeight - 6, 18);
  const labelMap = new Map(labels.map((item) => [item.name, item]));
  const tickValues = [-bound, -bound / 2, 0, bound / 2, bound];
  const timeTicks = TRADING_TIME_TICKS[period] || TRADING_TIME_TICKS["full-day"];

  return (
    <div className="chart-scroll" aria-label="板块资金流向曲线，可横向滚动">
      <svg className="flow-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="chart-title chart-desc">
        <title id="chart-title">板块{FLOW_TYPES[flowType].label}{INTERVAL_LABELS[interval]}净流入累计曲线</title>
        <desc id="chart-desc">红色表示净流入，绿色表示净流出，单位亿元；横轴固定展示完整交易时段，午休区间压缩。</desc>
        <rect x="0" y="0" width={width} height={height} fill="#fff" />
        {tickValues.map((tick) => (
          <g key={tick}>
            <line x1={margin.left} x2={margin.left + plotWidth} y1={y(tick)} y2={y(tick)} className={tick === 0 ? "zero-line" : "grid-line"} />
            <text x={margin.left - 12} y={y(tick) + 4} textAnchor="end" className="axis-text">
              {Math.abs(tick) < 0.01 ? "0" : tick.toFixed(0)}
            </text>
          </g>
        ))}
        {timeTicks.map((tick) => (
          <g key={tick}>
            <line x1={x(tick)} x2={x(tick)} y1={margin.top} y2={margin.top + plotHeight} className="vertical-grid" />
            <text x={x(tick)} y={height - 22} textAnchor="middle" className="axis-text">
              {tick}
            </text>
          </g>
        ))}
        <text x="18" y={margin.top + plotHeight / 2} transform={`rotate(-90 18 ${margin.top + plotHeight / 2})`} textAnchor="middle" className="axis-title">
          {FLOW_TYPES[flowType].label}净流入（亿元，累计）
        </text>
        {visible.map((item) => {
          const isActive = !activeName || activeName === item.name;
          const finalPoint = item.points[item.points.length - 1];
          const finalValue = finalPoint[flowType];
          const finalX = x(finalPoint.time);
          const path = item.points.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(1)},${y(point[flowType]).toFixed(1)}`).join(" ");
          const label = labelMap.get(item.name);
          const color = finalValue >= 0 ? "#c83b35" : "#087f64";
          return (
            <g
              key={item.code}
              className="series-group"
              opacity={isActive ? 1 : 0.12}
              onMouseEnter={() => onHoverName(item.name)}
              onMouseLeave={() => onHoverName("")}
              onClick={() => onPinnedName(pinnedName === item.name ? "" : item.name)}
            >
              <path d={path} fill="none" stroke={color} strokeWidth={activeName === item.name ? 3.2 : 1.7} strokeLinecap="round" strokeLinejoin="round" />
              <circle cx={finalX} cy={y(finalValue)} r={activeName === item.name ? 3.2 : 2.2} fill={color} />
              <line
                x1={finalX}
                y1={y(finalValue)}
                x2={margin.left + plotWidth + 54}
                y2={label?.labelY || y(finalValue)}
                stroke={color}
                strokeWidth="1"
                strokeDasharray={finalX < margin.left + plotWidth - 1 ? "3 4" : undefined}
                opacity="0.38"
              />
              <circle cx={margin.left + plotWidth + 54} cy={label?.labelY || y(finalValue)} r="2.8" fill={color} />
              <text x={margin.left + plotWidth + 67} y={(label?.labelY || y(finalValue)) + 4.5} fill={color} className="end-label">
                {item.name} <tspan fontWeight="700">{formatYi(finalValue, true)}</tspan>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function MarketTurnoverChart({ points }) {
  const width = 1180;
  const height = 350;
  const margin = { top: 30, right: 30, bottom: 52, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(1, ...points.map((point) => point.total));
  const bound = Math.ceil((maxValue * 1.08) / 2000) * 2000;
  const officialPoints = points.filter((point) => !point.isEstimate);
  const average = officialPoints.reduce((sum, point) => sum + point.total, 0) / Math.max(officialPoints.length, 1);
  const x = (index) => margin.left + (index / Math.max(points.length - 1, 1)) * plotWidth;
  const y = (value) => margin.top + ((bound - value) / bound) * plotHeight;
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.total).toFixed(1)}`).join(" ");
  const latestIsEstimate = Boolean(points[points.length - 1]?.isEstimate);
  const latestIsStaleEstimate = Boolean(points[points.length - 1]?.isStaleEstimate);
  const solidCount = latestIsEstimate ? points.length - 1 : points.length;
  const solidLine = points.slice(0, solidCount)
    .map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.total).toFixed(1)}`)
    .join(" ");
  const estimateLine = latestIsEstimate && points.length > 1
    ? points.slice(-2).map((point, offset) => `${offset ? "L" : "M"}${x(points.length - 2 + offset).toFixed(1)},${y(point.total).toFixed(1)}`).join(" ")
    : "";
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const yTicks = [0, bound / 3, (bound * 2) / 3, bound];
  const tickStep = Math.max(1, Math.ceil((points.length - 1) / 6));
  const xTicks = points.filter((_, index) => index === 0 || index === points.length - 1 || index % tickStep === 0);

  return (
    <div className="turnover-chart-scroll" aria-label="过去30个交易日A股成交额曲线，可横向滚动">
      <svg className="turnover-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="turnover-chart-title turnover-chart-desc">
        <title id="turnover-chart-title">过去30个交易日A股成交额曲线</title>
        <desc id="turnover-chart-desc">上交所主板A股和科创板，加深交所主板A股和创业板，单位亿元；虚线末段为盘中预估。</desc>
        <defs>
          <linearGradient id="turnover-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ef5c1a" stopOpacity="0.24" />
            <stop offset="100%" stopColor="#ef5c1a" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {yTicks.map((tick) => (
          <g key={tick}>
            <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} className="grid-line" />
            <text x={margin.left - 12} y={y(tick) + 4} textAnchor="end" className="axis-text">
              {tick >= 10_000 ? `${(tick / 10_000).toFixed(1)}万` : tick.toFixed(0)}
            </text>
          </g>
        ))}
        {xTicks.map((point) => {
          const index = points.indexOf(point);
          return (
            <text key={point.tradeDate} x={x(index)} y={height - 20} textAnchor="middle" className="axis-text">
              {formatShortDate(point.tradeDate)}
            </text>
          );
        })}
        <line x1={margin.left} x2={width - margin.right} y1={y(average)} y2={y(average)} className="turnover-average-line" />
        <text x={width - margin.right} y={y(average) - 8} textAnchor="end" className="turnover-average-label">
          正式日均值 {formatTurnoverYi(average)}
        </text>
        <path d={area} fill="url(#turnover-fill)" />
        {solidLine ? <path d={solidLine} fill="none" stroke="#ef5c1a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /> : null}
        {estimateLine ? <path d={estimateLine} className="turnover-estimate-segment" fill="none" /> : null}
        {points.map((point, index) => (
          <circle key={point.tradeDate} cx={x(index)} cy={y(point.total)} r={index === points.length - 1 ? 5 : 3} className={`turnover-point${point.isEstimate ? " is-estimate" : ""}`}>
            <title>{`${point.tradeDate} A股 ${point.isStaleEstimate ? "缓存预估 " : point.isEstimate ? "预估 " : ""}${formatTurnoverYi(point.total)}（沪 ${formatTurnoverYi(point.shanghai)} / 深 ${formatTurnoverYi(point.shenzhen)}）${point.isEstimate ? `；已成交 ${formatTurnoverYi(point.observedTotal)}，观测至 ${point.observedAt}` : ""}`}</title>
          </circle>
        ))}
        {latestIsEstimate ? (
          <text x={x(points.length - 1) - 10} y={Math.max(18, y(points[points.length - 1].total) - 12)} textAnchor="end" className="turnover-estimate-label">
            {latestIsStaleEstimate ? "缓存预估" : "预估"}
          </text>
        ) : null}
        <text x="18" y={margin.top + plotHeight / 2} transform={`rotate(-90 18 ${margin.top + plotHeight / 2})`} textAnchor="middle" className="axis-title">
          成交额（亿元）
        </text>
      </svg>
    </div>
  );
}

function MarketTurnoverPanel({ payload, status }) {
  const points = payload.points || [];
  const latest = points[points.length - 1];
  const previous = points[points.length - 2];
  const officialPoints = points.filter((point) => !point.isEstimate);
  const average = officialPoints.reduce((sum, point) => sum + point.total, 0) / Math.max(officialPoints.length, 1);
  const isEstimate = Boolean(latest?.isEstimate);
  const isStaleEstimate = Boolean(latest?.isStaleEstimate);
  const dayChange = latest && previous && previous.total
    ? ((latest.total - previous.total) / previous.total) * 100
    : null;

  return (
    <section className="turnover-section">
      <div className="turnover-heading">
        <div>
          <p className="eyebrow">MARKET LIQUIDITY</p>
          <h2>过去30个交易日 A 股成交额</h2>
          <p className="panel-copy">上交所主板A股与科创板，加深交所主板A股与创业板；不含B股、基金和债券。</p>
        </div>
        <div className={`turnover-freshness status-${status.state}`}>
          <span className="status-dot" />
          <span>{status.message}</span>
        </div>
      </div>
      {points.length ? (
        <>
          <div className="turnover-kpis" aria-label="A股成交额摘要">
            <div>
              <span>{isEstimate ? "今日成交额预估" : "最新成交额"}{isEstimate ? <em className="estimate-badge">{isStaleEstimate ? "缓存预估" : "预估"}</em> : null}</span>
              <strong>{isEstimate ? "≈" : ""}{formatTurnoverYi(latest.total)}</strong>
              <small>{latest.tradeDate}{isEstimate ? ` · 已成交 ${formatTurnoverYi(latest.observedTotal)}` : ""}</small>
            </div>
            <div><span>正式日均值</span><strong>{formatTurnoverYi(average)}</strong><small>最近 {officialPoints.length} 个正式交易日</small></div>
            <div>
              <span>{isEstimate ? "预估较前一日" : "较前一日"}</span>
              <strong className={dayChange >= 0 ? "positive" : "negative"}>{dayChange === null ? "--" : `${dayChange >= 0 ? "+" : ""}${dayChange.toFixed(1)}%`}</strong>
              <small>{previous ? `${formatTurnoverYi(previous.total)} → ${formatTurnoverYi(latest.total)}` : "等待更多数据"}</small>
            </div>
          </div>
          <MarketTurnoverChart points={points} />
          {isEstimate ? (
            <div className="turnover-estimate-note">
              <strong>{isStaleEstimate ? "缓存预估，行情源正在重试" : "盘中预估，非交易所收盘正式值"}</strong>
              <span>
                已成交额 ÷ 近 {latest.historyDays} 日同一时点{latest.profileBasis === "volume-proxy" ? "指数成交量完成度中位数（作为成交额完成度代理）" : "成交额完成度中位数"}，再向近期正式日成交额适度收缩；当前观测至 {latest.observedAt}，历史完成度约 {(latest.completionRatio * 100).toFixed(1)}%。
                {isStaleEstimate ? ` 当前沿用最近成功数据，缓存约 ${latest.sourceAgeSeconds} 秒；上游恢复后自动更新。` : " 收盘后自动替换为沪深交易所正式值。"}
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <div className="turnover-empty">正在等待官方交易所数据首次回补，完成后将在这里显示真实曲线。</div>
      )}
    </section>
  );
}

function FundBuckets({ series, period }) {
  const buckets = Object.entries(FLOW_TYPES).map(([key, config]) => {
    const value = series.reduce((sum, item) => {
      const points = filterPoints(item.points, period);
      return sum + (points[points.length - 1]?.[key] || 0);
    }, 0);
    return { key, label: config.label, value };
  });
  const max = Math.max(1, ...buckets.map((item) => Math.abs(item.value)));
  return (
    <div className="bucket-list">
      {buckets.map((item) => (
        <div className="bucket-row" key={item.key}>
          <span className="bucket-label">{item.label}</span>
          <span className={`bucket-number ${item.value >= 0 ? "positive" : "negative"}`}>{formatYi(item.value, true)}</span>
          <div className="bucket-track" aria-label={`${item.label}${formatYi(item.value, true)}`}>
            <div className="bucket-zero" />
            <div
              className={`bucket-bar ${item.value >= 0 ? "bar-positive" : "bar-negative"}`}
              style={{
                width: `${(Math.abs(item.value) / max) * 48}%`,
                left: item.value >= 0 ? "50%" : `${50 - (Math.abs(item.value) / max) * 48}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function StockLeaderGroup({ board, payload, status, direction }) {
  const stocks = payload?.stocks || [];
  const directionLabel = direction === "outflow" ? "净流出" : "净流入";

  return (
    <section className={`stock-side-group is-${direction}`} aria-labelledby={`stock-${direction}-title`}>
      <div className="stock-side-heading">
        <h3 id={`stock-${direction}-title`}>{directionLabel} Top5</h3>
        <small>{stocks.length} / 5</small>
      </div>
      {stocks.length ? (
        <div className="stock-leader-list" aria-label={`${board?.name || "所选板块"}主力${directionLabel}前五个股`}>
          {stocks.map((stock, index) => {
            const selectedFlow = Number.isFinite(stock.selectedFlow) ? stock.selectedFlow : stock.snapshotMain;
            return (
              <div className="stock-leader-row" key={`${stock.market}:${stock.code}`}>
                <span className="rank-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="stock-identity">
                  <strong>{stock.name}</strong>
                  <small>{stock.code}{Number.isFinite(stock.price) ? ` · ${stock.price.toFixed(2)}元` : ""}</small>
                </span>
                <span className="stock-values">
                  <strong className={selectedFlow >= 0 ? "positive" : "negative"}>{formatYi(selectedFlow, true)}</strong>
                  <small className={stock.changePct >= 0 ? "positive" : "negative"}>{formatPct(stock.changePct)}</small>
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="stock-side-empty">{status?.message || `暂无${directionLabel}个股数据`}</div>
      )}
    </section>
  );
}

function StockLeadersPanel({ board, payload, status }) {
  const latestMinute = [payload.inflow?.meta?.latestMinute, payload.outflow?.meta?.latestMinute]
    .filter(Boolean)
    .sort()
    .at(-1);
  const snapshotMinute = [payload.inflow?.meta?.snapshotMinute, payload.outflow?.meta?.snapshotMinute]
    .filter(Boolean)
    .sort()
    .at(-1);
  const isLoading = status.inflow?.state === "loading" || status.outflow?.state === "loading";
  const commonState = latestMinute ? "live" : isLoading ? "loading" : "fallback";
  const commonMessage = latestMinute
    ? `数据至 ${latestMinute}`
    : snapshotMinute
      ? `快照 ${snapshotMinute}`
      : isLoading
        ? "正在读取两端个股排行…"
        : "等待后台自动回补";

  return (
    <div className="stock-panel">
      <p className="eyebrow">STOCK LEADERS</p>
      <h2>Top5 个股</h2>
      <div className="stock-panel-intro">
        <p className="panel-copy">
          {board ? `${board.name} · 主力净流入 / 净流出两端排行` : "请先选择一个板块"}
        </p>
        <div className={`stock-data-status status-${commonState}`} aria-live="polite">
          <span className="status-dot" />
          <span>{commonMessage}</span>
        </div>
      </div>
      <div className="stock-sides">
        <StockLeaderGroup board={board} payload={payload.inflow} status={status.inflow} direction="inflow" />
        <StockLeaderGroup board={board} payload={payload.outflow} status={status.outflow} direction="outflow" />
      </div>
    </div>
  );
}

function DataMethodDialog({ open, onClose }) {
  const closeRef = useRef(null);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="method-dialog" role="dialog" aria-modal="true" aria-labelledby="method-title">
        <button ref={closeRef} className="dialog-close" type="button" onClick={onClose}>关闭</button>
        <p className="eyebrow">DATA METHOD</p>
        <h2 id="method-title">分钟与 5 分钟板块资金流怎么得到</h2>
        <ol>
          <li>板块目录：行业用 <code>m:90+t:2</code>，概念用 <code>m:90+t:3</code>，读取板块代码和名称。</li>
          <li>分钟资金：对 <code>90.BKxxxx</code> 请求 <code>stock/fflow/kline/get</code>，参数 <code>klt=1</code>。</li>
          <li>5 分钟采样：数据是日内累计值，每个 5 分钟桶取最后一条；不要把 1 分钟累计值相加。</li>
          <li>字段：<code>f51</code> 时间，<code>f52</code> 主力，<code>f53</code> 小单，<code>f54</code> 中单，<code>f55</code> 大单，<code>f56</code> 超大单；金额单位元。</li>
          <li>本地服务：后台每分钟采集，原始分钟数据写入 DuckDB；采集器会限制并发、重试备用域名并记录每次运行结果。</li>
          <li>前端通过 <code>interval=1m/5m</code> 切换分钟明细与 5 分钟视图，每 60 秒自动刷新；测试样本不会写入真实数据库。</li>
          <li>个股排行：每 5 分钟分别抓取板块主力净流入与净流出两端各 5 只，回补完整日内分钟资金并去重落库。</li>
          <li>A股成交额：按交易日读取上交所主板A股与科创板、深交所主板A股与创业板的官方每日成交金额并求和，不包含B股、基金和债券。</li>
        </ol>
        <div className="formula-block">
          <code>flow_5m[sector, bucket] = last(flow_1m.cumulative_value)</code>
        </div>
        <p className="method-note">“资金流”是数据商根据主动买卖方向和单量档位计算的统计口径，并非交易所公布的真实资金进出。</p>
      </section>
    </div>
  );
}

export function App() {
  const [boardType, setBoardType] = useState("industry");
  const [flowType, setFlowType] = useState("main");
  const [interval, setInterval] = useState("5m");
  const [period, setPeriod] = useState("full-day");
  const [topN, setTopN] = useState(18);
  const [tradeDate, setTradeDate] = useState("latest");
  const [tradeDates, setTradeDates] = useState([]);
  const [mode, setMode] = useState("demo");
  const [liveSeries, setLiveSeries] = useState([]);
  const [status, setStatus] = useState({ state: "loading", message: "正在连接本地 DuckDB 服务…" });
  const [hoveredName, setHoveredName] = useState("");
  const [pinnedName, setPinnedName] = useState("");
  const [methodOpen, setMethodOpen] = useState(false);
  const [turnoverPayload, setTurnoverPayload] = useState({ meta: {}, points: [] });
  const [turnoverStatus, setTurnoverStatus] = useState({ state: "loading", message: "正在读取官方成交额历史…" });
  const [selectedBoardCode, setSelectedBoardCode] = useState("");
  const [stockLeadersPayload, setStockLeadersPayload] = useState({
    inflow: { meta: {}, stocks: [] },
    outflow: { meta: {}, stocks: [] },
  });
  const [stockLeadersStatus, setStockLeadersStatus] = useState({
    inflow: { state: "loading", message: "正在读取净流入个股…" },
    outflow: { state: "loading", message: "正在读取净流出个股…" },
  });
  const stockRequestRef = useRef(0);
  const demoSeries = useMemo(() => makeDemoSeries(boardType, interval), [boardType, interval]);
  const selectedTradeDate = tradeDate === "latest"
    ? tradeDates[0]?.tradeDate || "latest"
    : tradeDate;

  const loadTradeDates = useCallback(async () => {
    try {
      const response = await fetch(`/api/trade-dates?boardType=${boardType}`);
      if (!response.ok) throw new Error(`交易日 API ${response.status}`);
      const payload = await response.json();
      const dates = payload.dates || [];
      setTradeDates(dates);
      setTradeDate((current) => (
        current === "latest" || dates.some((item) => item.tradeDate === current)
          ? current
          : "latest"
      ));
    } catch {
      return;
    }
  }, [boardType]);

  const loadFromDatabase = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setStatus({
        state: "loading",
        message: interval === "1m" ? "正在读取本地分钟明细…" : "正在读取本地 5 分钟聚合数据…",
      });
    }
    try {
      const query = new URLSearchParams({
        boardType,
        flowType,
        interval,
        limit: String(topN),
        tradeDate,
      });
      const response = await fetch(`/api/flows?${query}`);
      if (!response.ok) throw new Error(`本地 API ${response.status}`);
      const payload = await response.json();
      if (payload.series?.length) {
        setLiveSeries(payload.series);
        setMode("live");
        setStatus({
          state: "live",
          message: `DuckDB 已连接 · ${interval === "1m" ? "分钟明细" : "SQL 5分钟聚合"} · 数据至 ${payload.meta.latestMinute} · 每60秒自动刷新`,
        });
      } else {
        setLiveSeries([]);
        setMode("demo");
        setStatus({ state: "fallback", message: "所选日期暂无真实分钟数据 · 当前显示演示曲线" });
      }
    } catch (error) {
      setMode("demo");
      setLiveSeries([]);
      setStatus({ state: "fallback", message: `${error.message || "本地服务不可用"} · 当前显示演示曲线` });
    }
  }, [boardType, flowType, interval, topN, tradeDate]);

  const loadMarketTurnover = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setTurnoverStatus({ state: "loading", message: "正在读取官方成交额历史…" });
    try {
      const response = await fetch("/api/market-turnover?limit=30");
      if (!response.ok) throw new Error(`成交额 API ${response.status}`);
      const payload = await response.json();
      setTurnoverPayload(payload);
      if (payload.points?.length) {
        const estimate = payload.meta?.estimate;
        setTurnoverStatus({
          state: payload.meta?.estimateError ? "fallback" : "live",
          message: payload.meta?.isLatestEstimate
            ? estimate?.isStale
              ? `缓存预估至 ${estimate?.observedAt || "最近5分钟"} · 上游重试中`
              : `盘中预估至 ${estimate?.observedAt || "最新5分钟"} · 每60秒更新`
            : payload.meta?.estimateError
              ? `盘中预估源暂不可用 · 显示官方数据至 ${payload.meta.latestTradeDate}`
              : `官方数据至 ${payload.meta.latestTradeDate} · 每60秒检查更新`,
        });
      } else {
        setTurnoverStatus({ state: "loading", message: "首次30日回补进行中" });
      }
    } catch (error) {
      setTurnoverStatus({ state: "fallback", message: error.message || "成交额数据暂不可用" });
    }
  }, []);

  useEffect(() => {
    void loadTradeDates();
    const timer = window.setInterval(() => void loadTradeDates(), 60_000);
    return () => window.clearInterval(timer);
  }, [loadTradeDates]);

  useEffect(() => {
    void loadFromDatabase();
    const timer = window.setInterval(() => void loadFromDatabase({ silent: true }), 60_000);
    return () => window.clearInterval(timer);
  }, [loadFromDatabase]);

  useEffect(() => {
    void loadMarketTurnover();
    const timer = window.setInterval(() => void loadMarketTurnover({ silent: true }), 60_000);
    return () => window.clearInterval(timer);
  }, [loadMarketTurnover]);

  const sourceSeries = mode === "live" && liveSeries.length ? liveSeries : demoSeries;
  const ranked = useMemo(() => {
    return sourceSeries
      .map((item) => {
        const points = filterPoints(item.points, period);
        return { ...item, latest: points[points.length - 1]?.[flowType] || 0 };
      })
      .sort((a, b) => Math.abs(b.latest) - Math.abs(a.latest))
      .slice(0, topN);
  }, [sourceSeries, period, flowType, topN]);

  const metrics = useMemo(() => {
    const values = ranked.map((item) => item.latest);
    return {
      total: values.reduce((sum, value) => sum + value, 0),
      inflow: values.filter((value) => value > 0).length,
      outflow: values.filter((value) => value < 0).length,
      spread: values.length ? Math.max(...values) - Math.min(...values) : 0,
    };
  }, [ranked]);

  const latestRanking = useMemo(
    () => [...ranked].sort((a, b) => b.latest - a.latest).slice(0, 10),
    [ranked],
  );
  const selectedBoard = latestRanking.find((item) => item.code === selectedBoardCode)
    || latestRanking[0]
    || null;
  const selectedBoardForStocks = selectedBoard?.code || "";

  useEffect(() => {
    setSelectedBoardCode((current) => (
      latestRanking.some((item) => item.code === current)
        ? current
        : latestRanking[0]?.code || ""
    ));
  }, [latestRanking]);

  const loadStockLeaders = useCallback(async ({ silent = false } = {}) => {
    const requestId = stockRequestRef.current + 1;
    stockRequestRef.current = requestId;
    if (!selectedBoardForStocks) {
      setStockLeadersPayload({
        inflow: { meta: {}, stocks: [] },
        outflow: { meta: {}, stocks: [] },
      });
      setStockLeadersStatus({
        inflow: { state: "fallback", message: "暂无可查询的板块" },
        outflow: { state: "fallback", message: "暂无可查询的板块" },
      });
      return;
    }
    if (!silent) {
      setStockLeadersPayload({
        inflow: { meta: {}, stocks: [] },
        outflow: { meta: {}, stocks: [] },
      });
      setStockLeadersStatus({
        inflow: { state: "loading", message: `正在读取${selectedBoard?.name || "所选板块"}净流入个股…` },
        outflow: { state: "loading", message: `正在读取${selectedBoard?.name || "所选板块"}净流出个股…` },
      });
    }
    const fetchDirection = async (direction) => {
      const query = new URLSearchParams({
        boardType,
        boardCode: selectedBoardForStocks,
        tradeDate: selectedTradeDate,
        flowType: "main",
        direction,
        limit: "5",
      });
      const response = await fetch(`/api/sector-stocks?${query}`);
      if (!response.ok) throw new Error(`个股 API ${response.status}`);
      return response.json();
    };

    const directions = ["inflow", "outflow"];
    const results = await Promise.allSettled(directions.map(fetchDirection));
    if (requestId !== stockRequestRef.current) return;

    const nextPayload = {};
    const nextStatus = {};
    directions.forEach((direction, index) => {
      const label = direction === "outflow" ? "净流出" : "净流入";
      const result = results[index];
      if (result.status === "fulfilled") {
        nextPayload[direction] = result.value;
        nextStatus[direction] = result.value.stocks?.length
          ? { state: "live", message: `真实${label}个股数据` }
          : { state: "fallback", message: `暂无${label}快照，等待后台5分钟采集` };
      } else {
        nextPayload[direction] = { meta: {}, stocks: [] };
        nextStatus[direction] = { state: "fallback", message: result.reason?.message || `${label}数据暂不可用` };
      }
    });
    setStockLeadersPayload(nextPayload);
    setStockLeadersStatus(nextStatus);
  }, [boardType, selectedBoard?.name, selectedBoardForStocks, selectedTradeDate]);

  useEffect(() => {
    void loadStockLeaders();
    const timer = window.setInterval(() => void loadStockLeaders({ silent: true }), 60_000);
    return () => window.clearInterval(timer);
  }, [loadStockLeaders]);

  const date = formatTradeDateLabel(selectedTradeDate);
  const chartPinnedName = ranked.some((item) => item.name === pinnedName) ? pinnedName : "";
  const chartActiveName = hoveredName || chartPinnedName;

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">MF</span>
          <div>
            <strong>MoneyFlow</strong>
            <span>A 股板块监测</span>
          </div>
        </div>
        <div className="header-actions">
          <button type="button" className="text-button" onClick={() => setMethodOpen(true)}>数据口径</button>
        </div>
      </header>

      <section className="page-heading">
        <div>
          <p className="date-line"><span>{date}</span> 板块资金流向</p>
          <p className="subtitle">每分钟后台采集 · DuckDB 落库 · 1/5 分钟切换 · 前端自动刷新</p>
        </div>
        <div className={`source-status status-${status.state}`}>
          <span className="status-dot" />
          <div>
            <strong>{mode === "live" ? "LIVE" : "DEMO"}</strong>
            <small>{status.message}</small>
          </div>
        </div>
      </section>

      <section className="control-strip" aria-label="图表筛选器">
        <label>
          板块体系
          <select
            value={boardType}
            onChange={(event) => {
              setBoardType(event.target.value);
              setTradeDate("latest");
              setSelectedBoardCode("");
            }}
          >
            <option value="industry">东财行业</option>
            <option value="concept">东财概念</option>
          </select>
        </label>
        <label className="date-control">
          交易日期
          <select value={selectedTradeDate} onChange={(event) => setTradeDate(event.target.value)}>
            {tradeDates.length ? tradeDates.map((item, index) => (
              <option key={item.tradeDate} value={item.tradeDate}>
                {item.tradeDate}{index === 0 ? "（最新）" : ""}
              </option>
            )) : <option value="latest">最新交易日</option>}
          </select>
        </label>
        <label>
          资金档位
          <select value={flowType} onChange={(event) => setFlowType(event.target.value)}>
            {Object.entries(FLOW_TYPES).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
          </select>
        </label>
        <label>
          交易时段
          <select value={period} onChange={(event) => setPeriod(event.target.value)}>
            {Object.entries(PERIOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <fieldset className="granularity-control">
          <legend>曲线粒度</legend>
          <div className="segmented-control">
            {Object.entries(INTERVAL_LABELS).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={interval === value ? "is-active" : ""}
                aria-pressed={interval === value}
                onClick={() => setInterval(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
        <label>
          展示数量
          <select value={topN} onChange={(event) => setTopN(Number(event.target.value))}>
            <option value="12">12 个</option>
            <option value="18">18 个</option>
            <option value="24">24 个</option>
          </select>
        </label>
      </section>

      <section className="metric-strip" aria-label="资金流摘要">
        <div><span>所选板块合计</span><strong className={metrics.total >= 0 ? "positive" : "negative"}>{formatYi(metrics.total, true)}</strong></div>
        <div><span>净流入板块</span><strong>{metrics.inflow}<small> / {ranked.length}</small></strong></div>
        <div><span>净流出板块</span><strong>{metrics.outflow}<small> / {ranked.length}</small></strong></div>
        <div><span>首尾差</span><strong>{formatYi(metrics.spread)}</strong></div>
      </section>

      <section className="chart-section">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">INTRADAY FLOW</p>
            <h1>{FLOW_TYPES[flowType].label}资金流入曲线</h1>
          </div>
          <p>悬停临时聚焦，点击曲线锁定或取消</p>
        </div>
        <FlowChart
          series={ranked}
          flowType={flowType}
          interval={interval}
          period={period}
          activeName={chartActiveName}
          pinnedName={chartPinnedName}
          onHoverName={setHoveredName}
          onPinnedName={setPinnedName}
        />
      </section>

      <MarketTurnoverPanel payload={turnoverPayload} status={turnoverStatus} />

      <section className="lower-grid">
        <div className="bucket-panel">
          <p className="eyebrow">ORDER SIZE MIX</p>
          <h2>资金分档合计</h2>
          <p className="panel-copy">当前筛选板块的最新累计值，仅用于结构比较；行业和概念存在成分重叠，不代表全市场可加总金额。</p>
          <FundBuckets series={ranked} period={period} />
        </div>
        <div className="ranking-panel">
          <p className="eyebrow">LATEST RANKING</p>
          <h2>最新板块排行</h2>
          <p className="panel-copy">点击板块，在右侧同时查看主力净流入与净流出 Top5 个股。</p>
          <div className="ranking-list">
            {latestRanking.map((item, index) => (
              <button
                key={item.code}
                type="button"
                className={item.code === selectedBoardForStocks ? "is-selected" : ""}
                aria-pressed={item.code === selectedBoardForStocks}
                onMouseEnter={() => setHoveredName(item.name)}
                onMouseLeave={() => setHoveredName("")}
                onClick={() => {
                  setSelectedBoardCode(item.code);
                  setHoveredName("");
                }}
              >
                <span className="rank-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="rank-name">{item.name}</span>
                <strong className={item.latest >= 0 ? "positive" : "negative"}>{formatYi(item.latest, true)}</strong>
              </button>
            ))}
          </div>
        </div>
        <StockLeadersPanel
          board={selectedBoard}
          payload={stockLeadersPayload}
          status={stockLeadersStatus}
        />
      </section>

      <footer>
        <p>本地链路：东方财富公开行情与沪深交易所每日概况 → Node 采集器 → DuckDB → 板块、个股分钟/5分钟及30日成交额 API → 前端60秒轮询。</p>
        <p>本页面不构成投资建议。资金流为数据商统计口径，不是交易所官方资金进出。</p>
      </footer>

      <DataMethodDialog open={methodOpen} onClose={() => setMethodOpen(false)} />
    </main>
  );
}
