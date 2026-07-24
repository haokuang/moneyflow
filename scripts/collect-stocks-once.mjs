import { databasePath, port } from "../server/config.mjs";
import { MoneyflowDatabase } from "../server/db.mjs";
import { StockHistoryCollector } from "../server/stock-collector.mjs";

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/collect-stocks`, { method: "POST" });
  if (!response.ok) throw new Error(`local service ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
} catch {
  const database = await MoneyflowDatabase.create(databasePath);
  try {
    const collector = new StockHistoryCollector(database);
    console.log(JSON.stringify(await collector.collect("cli"), null, 2));
  } finally {
    await database.close();
  }
}
