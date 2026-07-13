import { createClient } from "redis";

let _redisClient = null;

export const connectRedis = async () => {
  if (_redisClient?.isReady) {
    return _redisClient;
  }

  _redisClient = createClient({
    url: process.env.REDIS_URL,
    database: Number(process.env.REDIS_DB) || 0,
  });

  _redisClient.on("error", (err) => {
    console.log("Redis Client Error", err);
  });

  await _redisClient.connect();
  return _redisClient;
};

export const getRedisClient = () => {
  if (!_redisClient) {
    throw new Error("Redis client not initialized. Call connectRedis first.");
  }
  return _redisClient;
};
