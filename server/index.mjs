import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MoneyflowCollector } from "./collector.mjs";
import { databasePath, host, port, projectRoot } from "./config.mjs";
import { MoneyflowDatabase } from "./db.mjs";
import { StockHistoryCollector } from "./stock-collector.mjs";

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

const database = await MoneyflowDatabase.create(databasePath);
const collector = new MoneyflowCollector(database);
collector.start();
const stockCollector = new StockHistoryCollector(database);
stockCollector.start();

const development = process.env.NODE_ENV !== "production";
const vite = development
  ? await (await import("vite")).createServer({
      root: projectRoot,
      server: { middlewareMode: true },
      appType: "spa",
    })
  : null;

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/health") {
      return sendJson(response, 200, {
        ok: true,
        database: database.filePath,
        collector: collector.getStatus(),
        stockCollector: stockCollector.getStatus(),
      });
    }
    if (url.pathname === "/api/status") {
      return sendJson(response, 200, {
        database: await database.getStatus(),
        collector: collector.getStatus(),
        stockCollector: stockCollector.getStatus(),
      });
    }
    if (url.pathname === "/api/trade-dates" && request.method === "GET") {
      const boardType = url.searchParams.get("boardType") === "concept" ? "concept" : "industry";
      return sendJson(response, 200, await database.getTradeDates(boardType));
    }
    if (url.pathname === "/api/flows" && request.method === "GET") {
      const boardType = url.searchParams.get("boardType") === "concept" ? "concept" : "industry";
      const flowType = url.searchParams.get("flowType") || "main";
      const limit = Number(url.searchParams.get("limit") || 18);
      const tradeDate = url.searchParams.get("tradeDate") || "latest";
      const interval = url.searchParams.get("interval") === "1m" ? "1m" : "5m";
      return sendJson(response, 200, await database.getFlowSeries({
        boardType,
        flowType,
        limit,
        tradeDate,
        interval,
      }));
    }
    if (url.pathname === "/api/sector-stocks" && request.method === "GET") {
      const boardType = url.searchParams.get("boardType") === "concept" ? "concept" : "industry";
      const boardCode = url.searchParams.get("boardCode") || "";
      if (!/^BK\d+$/.test(boardCode)) {
        return sendJson(response, 400, { error: "boardCode must look like BK1036" });
      }
      const tradeDate = url.searchParams.get("tradeDate") || "latest";
      const flowType = url.searchParams.get("flowType") || "main";
      const limit = Number(url.searchParams.get("limit") || 5);
      return sendJson(response, 200, await database.getSectorStockLeaders({
        boardType,
        boardCode,
        tradeDate,
        flowType,
        limit,
      }));
    }
    if (url.pathname === "/api/collect" && request.method === "POST") {
      return sendJson(response, 200, await collector.collect("manual"));
    }
    if (url.pathname === "/api/collect-stocks" && request.method === "POST") {
      return sendJson(response, 200, await stockCollector.collect("manual"));
    }

    if (vite) return vite.middlewares(request, response, () => sendJson(response, 404, { error: "Not found" }));

    const clientRoot = path.join(projectRoot, "dist", "client");
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const safePath = path.resolve(clientRoot, `.${requested}`);
    const filePath = safePath.startsWith(clientRoot) ? safePath : path.join(clientRoot, "index.html");
    try {
      const body = await fs.readFile(filePath);
      response.writeHead(200, { "Content-Type": contentType(filePath) });
      return response.end(body);
    } catch {
      const body = await fs.readFile(path.join(clientRoot, "index.html"));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end(body);
    }
  } catch (error) {
    console.error("[api]", error);
    return sendJson(response, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`MoneyFlow local service: http://localhost:${port}`);
  console.log(`DuckDB: ${databasePath}`);
});

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  collector.stop();
  stockCollector.stop();
  await vite?.close();
  await new Promise((resolve) => server.close(resolve));
  await database.close();
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
