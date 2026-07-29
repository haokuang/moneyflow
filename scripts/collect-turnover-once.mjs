import { port } from "../server/config.mjs";

const response = await fetch(`http://127.0.0.1:${port}/api/collect-turnover`, { method: "POST" }).catch(() => null);
if (!response) {
  console.error("本地服务未运行，请先启动服务再触发成交额采集。");
  process.exit(1);
}
const payload = await response.json();
console.log(JSON.stringify(payload, null, 2));
if (!response.ok || payload.status === "failed") process.exitCode = 1;
