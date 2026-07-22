import { useEffect, useMemo, useRef, useState } from "react";

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

const EASTMONEY_ENDPOINTS = {
  boardList: "https://push2.eastmoney.com/api/qt/clist/get",
  minuteFlow: "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get",
};

function createTradingTimes() {
  const times = [];
  const append = (startHour, startMinute, points) => {
    for (let i = 0; i < points; i += 1) {
      const total = startHour * 60 + startMinute + i * 5;
      times.push(
        `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`,
      );
    }
  };
  append(9, 30, 25);
  append(13, 0, 25);
  return times;
}

const ALL_TIMES = createTradingTimes();

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

function makeDemoSeries(boardType) {
  const names = boardType === "industry" ? INDUSTRY_NAMES : CONCEPT_NAMES;
  return names.map((name, index) => {
    const random = seededNoise(stringSeed(`${boardType}-${name}`));
    const direction = index < 7 ? 1 : index > names.length - 9 ? -1 : random() > 0.58 ? 1 : -1;
    const magnitude = 0.4 + Math.pow(index < 7 ? 8 - index : index / names.length, 1.35) * 1.8;
    let main = 0;
    const points = ALL_TIMES.map((time, pointIndex) => {
      const openPulse = pointIndex < 8 ? 1.6 : pointIndex > 30 ? 0.72 : 1;
      const drift = direction * magnitude * openPulse * (0.08 + random() * 0.27);
      const reversal = Math.sin(pointIndex / 5 + index * 0.7) * magnitude * 0.08;
      main += drift + reversal + (random() - 0.5) * magnitude * 0.16;
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

function jsonp(url, params, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const callback = `__moneyflow_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const query = new URLSearchParams({ ...params, cb: callback });
    const timer = window.setTimeout(() => finish(new Error("数据源响应超时")), timeout);

    function finish(error, payload) {
      window.clearTimeout(timer);
      script.remove();
      delete window[callback];
      if (error) reject(error);
      else resolve(payload);
    }

    window[callback] = (payload) => finish(null, payload);
    script.onerror = () => finish(new Error("公开接口被网络策略拦截"));
    script.src = `${url}?${query.toString()}`;
    document.head.appendChild(script);
  });
}

function parseMinuteFlow(payload) {
  const rows = payload?.data?.klines;
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const buckets = new Map();

  rows.forEach((row) => {
    const values = row.split(",");
    const stamp = values[0] || "";
    const time = stamp.slice(-5);
    const [hour, minute] = time.split(":").map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
    const inSession =
      (hour === 9 && minute >= 30) ||
      hour === 10 ||
      (hour === 11 && minute <= 30) ||
      hour === 13 ||
      hour === 14 ||
      (hour === 15 && minute === 0);
    if (!inSession) return;
    const bucketMinute = Math.floor(minute / 5) * 5;
    const bucket = `${String(hour).padStart(2, "0")}:${String(bucketMinute).padStart(2, "0")}`;
    buckets.set(bucket, {
      time: bucket,
      main: Number(values[1]) / 1e8,
      small: Number(values[2]) / 1e8,
      medium: Number(values[3]) / 1e8,
      large: Number(values[4]) / 1e8,
      super: Number(values[5]) / 1e8,
    });
  });

  return [...buckets.values()].filter((point) => Number.isFinite(point.main));
}

async function loadBoardCandidates(boardType, count) {
  const fs = boardType === "industry" ? "m:90+t:2" : "m:90+t:3";
  const base = {
    pn: "1",
    pz: String(Math.max(8, Math.ceil(count / 2) + 3)),
    np: "1",
    fltt: "2",
    invt: "2",
    fid: "f62",
    fs,
    fields: "f12,f14,f62",
    ut: "bd1d9ddb04089700cf9c27f6f7426281",
  };
  const [positive, negative] = await Promise.all([
    jsonp(EASTMONEY_ENDPOINTS.boardList, { ...base, po: "1" }),
    jsonp(EASTMONEY_ENDPOINTS.boardList, { ...base, po: "0" }),
  ]);
  const rows = [...(positive?.data?.diff || []), ...(negative?.data?.diff || [])];
  const deduped = [...new Map(rows.map((row) => [row.f12, row])).values()];
  return deduped
    .filter((row) => row.f12 && row.f14)
    .sort((a, b) => Math.abs(Number(b.f62) || 0) - Math.abs(Number(a.f62) || 0))
    .slice(0, count);
}

async function loadLiveSeries(boardType, count) {
  const candidates = await loadBoardCandidates(boardType, count);
  const settled = await Promise.allSettled(
    candidates.map(async (board) => {
      const payload = await jsonp(EASTMONEY_ENDPOINTS.minuteFlow, {
        secid: `90.${board.f12}`,
        lmt: "0",
        klt: "1",
        fields1: "f1,f2,f3,f7",
        fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
        ut: "b2884a393a59ad64002292a3e90d46a5",
      });
      const points = parseMinuteFlow(payload);
      if (!points.length) throw new Error(`${board.f14}暂无分钟数据`);
      return { code: board.f12, name: board.f14, points };
    }),
  );
  const series = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
  if (series.length < Math.min(6, count)) throw new Error("可用板块分钟数据不足");
  return series;
}

function formatYi(value, signed = false) {
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}亿`;
}

function filterPoints(points, period) {
  if (period === "morning") return points.filter((point) => point.time < "12:00");
  if (period === "afternoon") return points.filter((point) => point.time >= "12:00");
  return points;
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

function FlowChart({ series, flowType, period, activeName, onActiveName }) {
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
  const x = (index, count) => margin.left + (index / Math.max(count - 1, 1)) * plotWidth;
  const y = (value) => margin.top + ((bound - value) / (bound * 2)) * plotHeight;
  const latest = visible.map((item) => {
    const value = item.points[item.points.length - 1][flowType];
    return { ...item, value, rawY: y(value) };
  });
  const labels = distributeLabels(latest, margin.top + 6, margin.top + plotHeight - 6, 18);
  const labelMap = new Map(labels.map((item) => [item.name, item]));
  const tickValues = [-bound, -bound / 2, 0, bound / 2, bound];
  const samplePoints = visible[0]?.points || [];
  const timeTicks = samplePoints
    .map((point, index) => ({ ...point, index }))
    .filter((point, index, arr) => index === 0 || index === arr.length - 1 || point.time.endsWith(":30") || point.time.endsWith(":00"))
    .filter((point, index, arr) => index === 0 || point.index - arr[index - 1].index >= 4);

  return (
    <div className="chart-scroll" aria-label="板块资金流向曲线，可横向滚动">
      <svg className="flow-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="chart-title chart-desc">
        <title id="chart-title">板块{FLOW_TYPES[flowType].label}净流入累计曲线</title>
        <desc id="chart-desc">红色表示净流入，绿色表示净流出，单位亿元。</desc>
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
          <g key={`${tick.time}-${tick.index}`}>
            <line x1={x(tick.index, samplePoints.length)} x2={x(tick.index, samplePoints.length)} y1={margin.top} y2={margin.top + plotHeight} className="vertical-grid" />
            <text x={x(tick.index, samplePoints.length)} y={height - 22} textAnchor="middle" className="axis-text">
              {tick.time}
            </text>
          </g>
        ))}
        <text x="18" y={margin.top + plotHeight / 2} transform={`rotate(-90 18 ${margin.top + plotHeight / 2})`} textAnchor="middle" className="axis-title">
          {FLOW_TYPES[flowType].label}净流入（亿元，累计）
        </text>
        {visible.map((item) => {
          const isActive = !activeName || activeName === item.name;
          const finalValue = item.points[item.points.length - 1][flowType];
          const path = item.points.map((point, index) => `${index ? "L" : "M"}${x(index, item.points.length).toFixed(1)},${y(point[flowType]).toFixed(1)}`).join(" ");
          const label = labelMap.get(item.name);
          const color = finalValue >= 0 ? "#c83b35" : "#087f64";
          return (
            <g
              key={item.code}
              className="series-group"
              opacity={isActive ? 1 : 0.12}
              onMouseEnter={() => onActiveName(item.name)}
              onMouseLeave={() => onActiveName("")}
              onClick={() => onActiveName(activeName === item.name ? "" : item.name)}
            >
              <path d={path} fill="none" stroke={color} strokeWidth={activeName === item.name ? 3.2 : 1.7} strokeLinecap="round" strokeLinejoin="round" />
              <line x1={margin.left + plotWidth} y1={y(finalValue)} x2={margin.left + plotWidth + 54} y2={label?.labelY || y(finalValue)} stroke={color} strokeWidth="1" opacity="0.45" />
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
        <h2 id="method-title">5 分钟板块资金流怎么得到</h2>
        <ol>
          <li>板块目录：行业用 <code>m:90+t:2</code>，概念用 <code>m:90+t:3</code>，读取板块代码和名称。</li>
          <li>分钟资金：对 <code>90.BKxxxx</code> 请求 <code>stock/fflow/kline/get</code>，参数 <code>klt=1</code>。</li>
          <li>5 分钟采样：数据是日内累计值，每个 5 分钟桶取最后一条；不要把 1 分钟累计值相加。</li>
          <li>字段：<code>f51</code> 时间，<code>f52</code> 主力，<code>f53</code> 小单，<code>f54</code> 中单，<code>f55</code> 大单，<code>f56</code> 超大单；金额单位元。</li>
          <li>生产化：服务端代理、并发限制、失败重试、按交易日落库，并记录源时间和缓存时间。</li>
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
  const [period, setPeriod] = useState("full-day");
  const [topN, setTopN] = useState(18);
  const [mode, setMode] = useState("demo");
  const [liveSeries, setLiveSeries] = useState([]);
  const [status, setStatus] = useState({ state: "demo", message: "演示数据 · 未连接实时行情" });
  const [updatedAt, setUpdatedAt] = useState("--:--");
  const [activeName, setActiveName] = useState("");
  const [methodOpen, setMethodOpen] = useState(false);
  const demoSeries = useMemo(() => makeDemoSeries(boardType), [boardType]);

  const refreshLive = async () => {
    setStatus({ state: "loading", message: "正在读取东方财富公开行情…" });
    try {
      const data = await loadLiveSeries(boardType, topN);
      setLiveSeries(data);
      setMode("live");
      setUpdatedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
      setStatus({ state: "live", message: "公开行情已连接 · 1 分钟累计值重采样为 5 分钟" });
    } catch (error) {
      setMode("demo");
      setStatus({ state: "fallback", message: `${error.message || "实时接口不可用"} · 已回退演示数据` });
    }
  };

  useEffect(() => {
    if (mode === "live") refreshLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardType]);

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

  const date = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" })
    .format(new Date())
    .replace("/", "月")
    .replace(/^0/, "") + "日";

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
          <button type="button" className="refresh-button" onClick={refreshLive} disabled={status.state === "loading"}>
            {status.state === "loading" ? "连接中…" : "连接实时数据"}
          </button>
        </div>
      </header>

      <section className="page-heading">
        <div>
          <p className="date-line"><span>{date}</span> 板块资金流向</p>
          <p className="subtitle">5 分钟级 · 累计净流入 · 红色净流入 / 绿色净流出</p>
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
          <select value={boardType} onChange={(event) => setBoardType(event.target.value)}>
            <option value="industry">东财行业</option>
            <option value="concept">东财概念</option>
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
        <label>
          展示数量
          <select value={topN} onChange={(event) => setTopN(Number(event.target.value))}>
            <option value="12">12 个</option>
            <option value="18">18 个</option>
            <option value="24">24 个</option>
          </select>
        </label>
        <div className="updated-at">源数据时间 <strong>{mode === "live" ? updatedAt : "演示样本"}</strong></div>
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
          <p>点击或悬停曲线可聚焦板块</p>
        </div>
        <FlowChart
          series={ranked}
          flowType={flowType}
          period={period}
          activeName={activeName}
          onActiveName={setActiveName}
        />
      </section>

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
          <div className="ranking-list">
            {[...ranked].sort((a, b) => b.latest - a.latest).slice(0, 10).map((item, index) => (
              <button key={item.code} type="button" onMouseEnter={() => setActiveName(item.name)} onMouseLeave={() => setActiveName("")} onClick={() => setActiveName(item.name)}>
                <span className="rank-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="rank-name">{item.name}</span>
                <strong className={item.latest >= 0 ? "positive" : "negative"}>{formatYi(item.latest, true)}</strong>
              </button>
            ))}
          </div>
        </div>
      </section>

      <footer>
        <p>数据路径：东方财富公开行情页 / push2；公开网页接口可能调整或限流，生产使用请评估授权、稳定性与合规要求。</p>
        <p>本页面不构成投资建议。资金流为数据商统计口径，不是交易所官方资金进出。</p>
      </footer>

      <DataMethodDialog open={methodOpen} onClose={() => setMethodOpen(false)} />
    </main>
  );
}
