import rateLimit from "express-rate-limit";

export const customRateLimit = (windowMinute, limit) => {
  const limiter = rateLimit({
    windowMs: windowMinute * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  return limiter;
};
