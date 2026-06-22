import mongoose from "mongoose";
import User from "../Models/userModel.js";
import { googleClient } from "../services/googleAuthService.js";
import { sendEmail } from "../services/email/sendEmailOtp.js";
import { redisClient } from "../config/redis.js";
import { sendOtpSchema } from "../validators/authSchema.js";

export const sendOtp = async (req, res) => {
  const { success, data, error } = sendOtpSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({ error: error.issues[0].message });
  }
  const { email, purpose } = data;

  const resData = await sendEmail(email, purpose);
  res.status(201).json(resData);
};

export const loginWithGoogle = async (req, res, next) => {
  const { idToken } = req.body;

  if (typeof idToken !== "string") {
    return res.status(400).json({ error: "Invalid token" });
  }

  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: googleClient._clientId,
  });

  const user = ticket.getPayload();

  if (!user?.email || !user.email_verified) {
    return res.status(401).json({ error: "Unverified Google account" });
  }

  const existingUser = await User.findOne({ email: user.email });

  if (!existingUser) {
    try {
      const userId = new mongoose.Types.ObjectId();

      const newUser = await User.create({
        _id: userId,
        username: user.name,
        email: user.email,
      });

      const sessionId = crypto.randomUUID();
      await redisClient
        .multi()
        .json.set(`session:${sessionId}`, "$", {
          userId: newUser._id,
          role: newUser.role,
          isBlocked: newUser.isBlocked,
          isPassAvailable: !!newUser.password,
        })
        .expire(`session:${sessionId}`, 60 * 60 * 24 * 7)
        .exec();

      res.cookie("sid", sessionId, {
        httpOnly: true,
        signed: true,
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 24 * 7,
      });
    } catch (error) {
      console.log(error);
      next();
    }
  }

  //LOGIN
  if (existingUser) {
    if (existingUser.isBlocked) {
      return res.status(403).json({
        message:
          "Your account has been banned. Please contact support if you believe this is a mistake",
      });
    }
    try {
      const allSessions = await redisClient.ft.search(
        "userIdIndex",
        `@userId:{${existingUser._id}}`,
        { RETURN: [] },
      );

      if (allSessions.total >= 2) {
        await redisClient.del(allSessions.documents[0].id);
      }

      const sessionId = crypto.randomUUID();
      await redisClient
        .multi()
        .json.set(`session:${sessionId}`, "$", {
          userId: existingUser._id,
          role: existingUser.role,
          isBlocked: existingUser.isBlocked,
          isPassAvailable: !!existingUser.password,
        })
        .expire(`session:${sessionId}`, 60 * 60 * 24 * 7)
        .exec();

      res.cookie("sid", sessionId, {
        httpOnly: true,
        signed: true,
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 24 * 7,
      });
    } catch (error) {
      console.log(error);
    }
  }

  res.status(200).json({ message: "User logged in" });
};
