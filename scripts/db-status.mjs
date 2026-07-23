import { databasePath, port } from "../server/config.mjs";
import { MoneyflowDatabase } from "../server/db.mjs";

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/status`);
  if (!response.ok) throw new Error(`local service ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
} catch {
  const database = await MoneyflowDatabase.create(databasePath);
  try {
    console.log(JSON.stringify(await database.getStatus(), null, 2));
  } finally {
    await database.close();
  }
}
