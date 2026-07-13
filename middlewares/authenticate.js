import { getRedisClient } from "../config/redis.js";
import { sidSchema } from "../validators/authSchema.js";

export const authenticate = async (req, res, next) => {
  try {
    const { sid } = req.signedCookies;

    if (!sid) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = sidSchema.safeParse(sid);
    if (!parsed.success) {
      res.clearCookie("sid", { httpOnly: true });
      return res.status(401).json({ error: "Invalid session" });
    }

    let session;
    try {
      const redisClient = getRedisClient();
      session = await redisClient.json.get(`session:${parsed.data}`);
    } catch {
      return res.status(503).json({ error: "Auth service unavailable" });
    }

    if (!session || !session.userId) {
      res.clearCookie("sid", { httpOnly: true });
      return res.status(401).json({ error: "Session expired" });
    }

    if (session.isBlocked) {
      return res.status(403).json({
        error:
          "Your account has been banned. Please contact support if you believe this is a mistake",
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
