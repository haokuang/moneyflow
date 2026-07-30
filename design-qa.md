**Source visual truth**

- `/var/folders/36/rqg7zp2d72d343l_wj8g6mmm0000gn/T/codex-clipboard-b8225f89-f11b-4bd8-bc73-a245ce6b63af.png`
- Source pixels: 1770 × 934. The lower dashboard region defines the white canvas, orange uppercase eyebrows, dark Chinese headings, muted explanatory copy, red/green semantic values, thin dividers, and compact ranking density.
- Durable user feedback in the current browser annotation overrides the prior toggle behavior: net-inflow and net-outflow Top 5 lists must be expanded simultaneously.

**Rendered implementation**

- Full page: `/Users/bytedance/Documents/codex-projects/moneyflow/design-qa-stock-both.png` (1265 × 2476).
- Focused lower region: `/Users/bytedance/Documents/codex-projects/moneyflow/design-qa-stock-both-focused.png` (1265 × 712).
- URL: `http://localhost:4173/` at a 1280 × 720 desktop viewport.
- State: Eastmoney industry boards, latest stored trading date, five-minute chart, `集成电路制造` selected to show real rows on both sides.

**Comparison evidence**

- The source and focused implementation screenshots were opened together in one comparison input.
- The requested three-column relationship remains intact: order-size totals, latest board ranking, and stock leaders each measure 363 px at the tested desktop viewport.
- The stock column now contains separate `净流入 Top5` and `净流出 Top5` sections. They use the established typography, dividers, tabular values, and red/green semantic colors, with no toggle or hidden list state.
- No raster imagery or icons appear in the target region, so there are no asset-fidelity substitutions to review.

**Interaction and data evidence**

- Default state selected the first ranked board and immediately rendered both list headings.
- Clicking `集成电路制造` changed the selected ranking state and updated both lists in one request cycle.
- The selected test board displayed one stored positive-flow stock and four stored negative-flow stocks. Counts are disclosed as `1 / 5` and `4 / 5` instead of inventing missing rows; the next successful five-minute Eastmoney collection can fill the remaining slots.
- DOM inspection confirmed both list regions were present simultaneously, the old stock-direction buttons were absent, all three desktop columns were equal width, and the page had no horizontal overflow.
- Automatic 60-second refresh remains active and uses independent inflow/outflow request results so one unavailable side does not hide the other.

**Findings**

- No actionable P0, P1, or P2 visual differences remain.
- Fonts and typography: existing Inter / Chinese system fallback, weights, scale, and hierarchy remain consistent with the source.
- Spacing and layout rhythm: compact 49 px stock rows keep both sections readable without making the third column visually heavier than the ranking column.
- Colors and visual tokens: orange, red, green, muted grey, white surfaces, and dividers match the established dashboard tokens.
- Image quality and asset fidelity: not applicable; the target region contains no image assets or icons.
- Copy and content: the ranking instruction and stock subtitle now state that both sides are shown together.

**Comparison history**

- Pass 1: simultaneous sections rendered correctly, but the default board had no stored outflow rows.
- Pass 2: selected a board with existing data on both sides and confirmed the list anatomy, semantic colors, equal-third layout, click linkage, and empty-row honesty. No further visual correction was required.

**Follow-up polish**

- P3: historical snapshots collected before the two-sided collector was added may contain fewer than five rows on either side until the upstream Eastmoney endpoints accept a new collection run.

**Latest annotation QA — complete trading-time x-axis**

- Source visual truth: the current browser annotation on `http://localhost:4173/`, target selector `main.dashboard-shell > section.chart-section:nth-of-type(4) > div.chart-scroll:nth-of-type(2) > svg.flow-chart`, captured at a 1074 × 1040 CSS viewport. The source showed a partial morning series stretched across the available plotting width and only the elapsed labels `09:30`, `10:00`, and `10:30`.
- Rendered implementation: `/Users/bytedance/Documents/codex-projects/moneyflow/design-qa-x-axis.png`, 1265 × 712 pixels at a 1280 × 720 CSS viewport and 1× density.
- State: 2026-07-30 live Eastmoney industry data, main-flow metric, full-day period, five-minute granularity, latest stored point around 10:54.
- Full-view evidence: the reference annotation and rendered chart were inspected in the same comparison context. The section hierarchy, chart size, grid, typography, colors, labels, and right-side ranking anatomy remain unchanged; only the time geometry and partial-series endpoint treatment changed.
- Focused evidence: full-day mode now exposes ten clock labels from `09:30` through `15:00`, with a 42 px compressed lunch gap between `11:30` and `13:00`. The latest live series endpoint measured at x≈315, between the `10:30` tick (x≈253) and `11:00` tick (x≈346), while `15:00` remains at x=854. Dashed leaders connect real endpoints to the established right-hand label column without presenting future values as solid curve data.
- Interaction evidence: morning mode retained exactly `09:30–11:30`; afternoon mode retained exactly `13:00–15:00` even before afternoon rows existed; both one-minute and five-minute modes rendered the complete full-day ticks. The page was returned to the default full-day, five-minute state.
- Fonts and typography: unchanged from the established Inter / Chinese system fallback; all ten axis labels remain readable at the tested desktop viewport.
- Spacing and layout rhythm: the chart frame and margins are unchanged; the lunch gap separates the two sessions without consuming a full 90-minute empty span.
- Colors and visual tokens: unchanged; partial-period leaders use the existing series colors at reduced opacity with a dashed stroke.
- Image quality and asset fidelity: not applicable; this chart is data-rendered SVG and contains no raster assets or icons.
- Copy and content: the accessible chart description now states that the axis uses the complete trading session and compresses the lunch interval.
- Findings: no actionable P0, P1, or P2 differences remain. P3: on very narrow screens the existing chart intentionally scrolls horizontally so all clock labels retain legibility.
- Comparison history: pass 1 verified the fixed full-day axis and found no blocking visual mismatch; interaction passes then confirmed morning, afternoon, one-minute, and five-minute states without requiring a correction loop.

final result: passed
