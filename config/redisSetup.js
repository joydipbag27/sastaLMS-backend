import "dotenv/config";
import { SCHEMA_FIELD_TYPE } from "redis";
import { redisClient } from "./redis.js";

await redisClient.ft.create(
  "userIdIndex",
  {
    "$.userId": { type: SCHEMA_FIELD_TYPE.TAG, AS: "userId" },
  },
  {
    ON: "JSON",
    PREFIX: "session:",
  },
);

await redisClient.quit();
console.log("Redis setup completed");
