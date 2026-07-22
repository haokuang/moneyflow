# A 股板块资金流 Dashboard

一个参考“板块资金流向”截图实现的响应式 React Dashboard。页面默认使用可复现的演示数据；点击“连接实时数据”后，会尝试读取东方财富公开行情并将 1 分钟累计资金流重采样为 5 分钟曲线。

## 本地运行

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 4173
```

生产构建与 Sites Worker 校验：

```bash
npm run build
npm run test:sites
```

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

## 生产化建议

浏览器直连公开 JSONP 接口适合原型，不适合作为稳定生产链路。正式使用时建议：

1. 后端在交易时段每分钟采集一次，保存原始响应和数据源时间戳。
2. 以 `trade_date + board_system + board_code + minute` 做唯一键，避免重复写入。
3. 服务端物化 5 分钟累计值和 5 分钟增量值，并向前端提供统一 API。
4. 增加并发限制、超时、重试、缓存、缺口检测和交易日历。
5. 需要长期稳定、历史回补或对外服务时，评估 Choice、Wind、iFinD 或合规的 Level-2 数据授权。

“资金流”通常是数据商根据主动买卖方向和成交单档位估算出的统计指标，不是交易所发布的真实资金进出；不同数据源的板块体系和口径不能直接混用。

