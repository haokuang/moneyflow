# A 股板块资金流 Dashboard

一个参考“板块资金流向”截图实现的本地全栈 Dashboard。Node.js 采集器在交易时段每分钟读取东方财富公开行情，原始 1 分钟累计资金流写入 DuckDB，SQL 视图聚合成 5 分钟曲线，React 前端每 60 秒读取本地 API。独立的个股历史采集器每 5 分钟抓取所跟踪行业的主力净流入前 5 成分股，并回补这些个股当日完整的 1 分钟资金流。市场成交额采集器从沪深交易所官方每日概况回补最近 30 个交易日，在页面显示 A 股成交额曲线。

## 本地运行

```bash
npm install
npm run dev
```

打开 `http://localhost:4173/`。服务启动时会立即尝试回补当日分钟数据，随后仅在交易时段每分钟采集。

构建、测试与状态检查：

```bash
npm run build
npm test
npm run db:status
npm run collect
npm run collect:stocks
npm run collect:turnover
```

数据库默认位于 `data/moneyflow.duckdb`，不会提交到 Git。

## Docker 部署

使用 Compose 构建并后台启动：

```bash
docker compose up -d --build
```

访问 `http://localhost:4173/`。DuckDB 保存在命名卷 `moneyflow_data` 中，容器更新或重建不会清空历史数据。

### 在另一台 Mac mini 部署

安装 Docker Desktop（或其他兼容 Docker Compose 的运行时）并登录 GitHub CLI 后：

```bash
gh auth login
gh repo clone haokuang/moneyflow
cd moneyflow
docker compose up -d --build
```

然后访问 `http://localhost:4173/`。首次启动会创建新的 DuckDB 数据卷并立即尝试采集当日数据；本机现有的历史数据库不会提交到 GitHub。

常用运维命令：

```bash
docker compose ps
docker compose logs -f moneyflow
docker compose exec moneyflow npm run db:status
docker compose exec moneyflow npm run collect
docker compose exec moneyflow npm run collect:stocks
docker compose exec moneyflow npm run collect:turnover
docker compose down
```

`docker compose down` 只停止并删除容器，不删除 DuckDB 数据卷。只有显式执行 `docker compose down -v` 才会删除数据，请谨慎使用。

修改宿主机端口或采集规模时，可复制 `.env.example` 为 `.env`，例如：

```text
MONEYFLOW_PORT=8080
BOARDS_PER_SIDE=20
FETCH_CONCURRENCY=6
```

单独构建镜像也可以使用：

```bash
docker build -t moneyflow:local .
docker run -d --name moneyflow -p 4173:4173 -v moneyflow_data:/app/data moneyflow:local
```

## 本地链路

```text
东方财富公开行情
  → 后台采集器（启动时一次；交易时段每60秒）
  → DuckDB minute_flow 原始分钟表
  → DuckDB flow_5m SQL 视图（每桶 arg_max(value, minute)）
  → GET /api/flows
  → React 前端每60秒刷新

东财行业板块
  → 每5分钟获取按主力净流入排序的前5成分股
  → DuckDB sector_constituent_snapshot 成分股快照
  → 去重后回补个股完整当日1分钟资金流
  → DuckDB stock_minute_flow / stock_flow_5m
  → GET /api/sector-stocks

腾讯指数日线（仅用于交易日历）
  → 上交所 / 深交所官方每日市场概况
  → DuckDB market_turnover_daily
  → 盘中叠加上证A股指数 / 深证A指5分钟成交额预估（不入正式表）
  → GET /api/market-turnover?limit=30
  → React 30日A股成交额曲线
```

本地 API：

- `GET /api/health`：服务和采集器状态
- `GET /api/status`：DuckDB 行数、最新交易日、最后一次采集结果
- `GET /api/trade-dates?boardType=industry`：已入库交易日列表，供前端日期选择
- `GET /api/flows?boardType=industry&flowType=main&interval=1m&limit=18`：1分钟曲线
- `GET /api/flows?boardType=industry&flowType=main&interval=5m&limit=18`：5分钟曲线（默认）
- `GET /api/sector-stocks?boardType=industry&boardCode=BK1036&tradeDate=latest&limit=5`：板块个股资金前5
- `GET /api/market-turnover?limit=30`：最近30个A股成交额；当日正式值未发布时，末点带 `isEstimate`、观测时间和算法信息
- `POST /api/collect`：手动触发一次采集
- `POST /api/collect-stocks`：手动触发一次成分股与个股历史采集
- `POST /api/collect-turnover`：手动触发一次A股成交额回补

## 数据路径

### 1. 获取板块目录

请求 `https://push2.eastmoney.com/api/qt/clist/get`：

- 东财行业：`fs=m:90+t:2`
- 东财概念：`fs=m:90+t:3`
- 板块代码 / 名称 / 主力净流入：`f12,f14,f62`

### 2. 获取板块 1 分钟累计资金流

对每个板块代码请求 `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get`：

- `secid=90.BKxxxx`
- `klt=1`
- `lmt=0`
- `fields2=f51,f52,f53,f54,f55,f56,...`

关键字段：

| 字段 | 含义 |
| --- | --- |
| `f51` | 时间 |
| `f52` | 主力净流入 |
| `f53` | 小单净流入 |
| `f54` | 中单净流入 |
| `f55` | 大单净流入 |
| `f56` | 超大单净流入 |

金额原始单位是元，页面除以 `1e8` 转为亿元。

### 3. 重采样到 5 分钟

分钟接口返回的是“当日累计值”。因此每个 5 分钟桶取最后一个 1 分钟观测值，不能把桶内 5 个累计值相加：

```text
flow_5m[sector, bucket] = last(flow_1m.cumulative_value)
```

若还需要“该 5 分钟新增净流入”，再对相邻 5 分钟累计值做差：

```text
increment_5m[t] = cumulative_5m[t] - cumulative_5m[t-1]
```

### 4. 个股级历史

个股采集器先用 `fs=b:BKxxxx` 查询板块成分股，按 `f62` 主力净流入降序保留前 N 个。每次快照写入：

- `sector_constituent_snapshot`：交易日、快照分钟、板块、股票、当时排名、价格、涨跌幅、主力净流入及占比。
- `stock_minute_flow`：按 `trade_date + market + code + minute` 去重的个股 1 分钟五档累计资金流。
- `stock_flow_5m`：与板块相同口径的个股 5 分钟视图。

同一股票可能属于多个板块，分钟资金流只保存一份；板块归属通过快照表关联。个股接口每次返回完整当日分钟序列，因此默认每 5 分钟回补一次即可得到 1 分钟历史，不需要对每只股票每分钟重复发起请求。

### 5. A股成交额历史

最近 30 个交易日的成交额使用沪深交易所官方每日市场概况，按以下口径求和：

```text
A股成交额 = 上交所主板A股 + 科创板 + 深交所主板A股 + 创业板A股
```

不包含 B 股、基金和债券。原始金额统一按元写入 `market_turnover_daily`，API 转为亿元。首次启动回补 30 个交易日；之后每轮只请求缺失日期和最新交易日，避免重复请求历史数据。

盘中正式日值尚未发布时，API 使用上证 A 股指数（000002）和深证 A 指（399107）的 5 分钟成交金额追加一个临时预估点：

```text
历史完成度 = 近20个完整交易日在当前时点的累计成交额 / 全日成交额的中位数
直接外推值 = 今日当前累计成交额 / 历史完成度
最终预估值 = 随完成度提高逐步加权直接外推值，并向近期正式日成交额中位数收缩
```

10:00 前不发布预估；结果始终不低于已成交额。预估只存在于 API 响应和前端展示，不写入 `market_turnover_daily`，并在交易所正式值发布后自动消失。前端以“≈”、预估徽标、虚线末段和算法说明明确区分。

## 运行参数

可通过环境变量调整：

- `PORT=4173`：本地端口
- `MONEYFLOW_DB_PATH=...`：DuckDB 文件位置
- `COLLECT_INTERVAL_MS=60000`：采集间隔
- `BOARDS_PER_SIDE=15`：每类板块分别取净流入/净流出前 N 个
- `BOARD_TYPES=industry,concept`：采集板块体系
- `FETCH_CONCURRENCY=6`：行情请求并发数
- `REQUEST_TIMEOUT_MS=10000`：单次请求超时
- `STOCK_HISTORY_ENABLED=1`：启用个股历史采集
- `STOCK_COLLECT_INTERVAL_MS=300000`：个股历史回补间隔，默认5分钟
- `STOCK_BOARD_TYPES=industry`：默认只采集东财行业，避免概念板块成分重叠造成请求膨胀
- `STOCK_BOARDS_PER_TYPE=30`：每个板块体系跟踪的板块数量
- `STOCKS_PER_BOARD=5`：每个板块按主力净流入保留的成分股数量
- `STOCK_FETCH_CONCURRENCY=4`：个股分钟接口并发数
- `MARKET_TURNOVER_ENABLED=1`：启用A股成交额历史采集
- `MARKET_TURNOVER_COLLECT_INTERVAL_MS=600000`：成交额检查间隔，默认10分钟
- `MARKET_TURNOVER_DAYS=30`：页面和首次回补的交易日数量
- `MARKET_TURNOVER_FETCH_CONCURRENCY=4`：沪深交易所历史回补并发数
- `FORCE_COLLECT=1`：测试时忽略交易时段限制

板块目录、成分股和分钟接口均有备用域名重试。若公开接口不可达，真实表不会写入伪数据；已有成分股快照可以用于继续尝试个股分钟回补。长期稳定运行仍应增加官方交易日历、缺口告警，并评估有 SLA 的授权数据源。

“资金流”通常是数据商根据主动买卖方向和成交单档位估算出的统计指标，不是交易所发布的真实资金进出；不同数据源的板块体系和口径不能直接混用。
