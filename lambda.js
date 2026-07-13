import ServerlessHttp from "serverless-http";
import app from "./app.js";
import { ConnectDB } from "./config/db.js";
import { connectRedis } from "./config/redis.js";

// Warm connection cache
await ConnectDB();
try {
  await connectRedis();
} catch (err) {
  console.error("Failed to connect to Redis on cold start:", err.message);
}

export const handler = ServerlessHttp(app);
