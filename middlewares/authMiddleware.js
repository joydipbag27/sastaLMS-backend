import { redisClient } from "../config/redis.js";
import { sidSchema } from "../validators/authSchema.js";

export const checkAuth = async (req, res, next) => {
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
      session = await redisClient.json.get(`session:${parsed.data}`);
    } catch {
      return res.status(503).json({ error: "Auth service unavailable" });
    }

    if (!session || !session.userId) {
      res.clearCookie("sid", { httpOnly: true });
      return res.status(401).json({ error: "Session expired" });
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

export const checkIfBlocked = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.user.isBlocked) {
    return res.status(403).json({
      error:
        "Your account has been banned. Please contact support if you believe this is a mistake",
      redirect: "/banned",
    });
  }

  next();
};

export const adminReadPrivilegesAuth = async (req, res, next) => {
  if (req.user.role !== "User") {
    next();
  } else {
    return res.status(403).json({ error: "You don't have read privileges" });
  }
};

export const adminWritePrivilegesAuth = async (req, res, next) => {
  if (req.user.role === "Admin" || "Owner") {
    next();
  } else {
    return res.status(403).json({ error: "You don't have this permission" });
  }
};
