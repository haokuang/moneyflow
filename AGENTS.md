# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Product decisions

- The intraday chart supports `1 minute` and `5 minute` display granularity, with `5 minute` as the default.
- The intraday chart always uses a complete trading-session x-axis. Full-day mode spans 09:30–11:30 and 13:00–15:00 with a compressed lunch break; morning and afternoon filters each retain their complete session range, so partial intraday data ends at its actual clock time instead of stretching to the chart edge.
- The intraday chart starts with every series at equal visual emphasis. The board selected by default for the stock Top 5 panel must not implicitly focus a chart series; hovering gives temporary focus, while clicking a curve independently locks or clears chart focus.
- The date selector lists only trading dates already stored in DuckDB, defaults to the latest available date for the selected board system, and keeps the chosen historical date during automatic refreshes.
- Stock-level history is persisted separately: snapshot both ends of the main-flow ranking and deduplicate each stock's one-minute flow across overlapping sectors. The default production cadence is a five-minute full-day backfill for the top five inflow and top five outflow stocks in tracked Eastmoney industry boards.
- The dashboard includes a rolling 30-trading-day A-share turnover curve. The metric is persisted in DuckDB and equals SSE Main Board A shares plus STAR Market turnover, plus SZSE Main Board A shares plus ChiNext turnover; exclude B shares, funds, and bonds.
- Intraday turnover estimation uses Eastmoney five-minute index turnover when available. If that source is unavailable, use Tencent's live cumulative A-share index turnover with recent five-minute index-volume completion as an explicitly labeled proxy; never present the fallback as official or direct turnover-profile data.
- When the latest trading day's official turnover is not yet published, the turnover curve may append one clearly marked intraday estimate. Estimate full-day turnover from the median same-time completion ratio of the latest 20 complete trading days, shrink it toward recent official daily turnover, disclose the observed amount/time and method, and replace it with the official SSE/SZSE value after publication. Never persist an estimate as an official daily row.
- Fetch the Shanghai and Shenzhen intraday turnover inputs independently with retry and backup hosts. On refresh failure, a recent successful estimate may be reused for at most five minutes only when it is explicitly labeled as cached; once that safety window expires, hide the estimate and surface the upstream availability warning instead of presenting stale data as current.
- The dashboard relies on automatic one-minute collection and 60-second frontend refreshes; do not expose a manual "collect now" button in the header.
- On desktop, the lower detail area uses three equal-width columns for order-size totals, latest board ranking, and the selected board's Top 5 stocks. The first ranked board is selected by default; clicking another board updates the Top 5 panel, net-inflow and net-outflow Top 5 stocks are both expanded at the same time without a toggle, and narrow screens stack the panels vertically.
