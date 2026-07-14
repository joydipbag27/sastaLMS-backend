import { getRedisClient } from "../config/redis.js";
import { sidSchema } from "../validators/authSchema.js";

/**
 * Like `authenticate`, but does NOT reject unauthenticated requests.
 * If a valid session exists, it populates req.user.
 * If not, it simply calls next() with req.user remaining undefined.
 * Use this on routes that have different behavior for authenticated vs
 * unauthenticated users (e.g. public-facing routes with tiered access).
 */
export const optionalAuthenticate = async (req, res, next) => {
  try {
    const { sid } = req.signedCookies;

    if (!sid) {
      return next(); // No session — continue as unauthenticated
    }

    const parsed = sidSchema.safeParse(sid);
    if (!parsed.success) {
      return next(); // Bad cookie — ignore and continue
    }

    let session;
    try {
      const redisClient = getRedisClient();
      session = await redisClient.json.get(`session:${parsed.data}`);
    } catch {
      return next(); // Redis unavailable — degrade gracefully
    }

    if (!session || !session.userId) {
      return next(); // Expired session — continue as unauthenticated
    }

    if (session.isBlocked) {
      return res.status(403).json({
        error: "Your account has been banned. Please contact support if you believe this is a mistake",
        redirect: "/banned",
      });
    }

    req.user = {
      _id: session.userId,
      rootDirId: session.rootDirId,
      role: session.role,
      isBlocked: session.isBlocked,
      isPassAvailable: session.isPassAvailable,
    };

    next();
  } catch (error) {
    next(error);
  }
};
