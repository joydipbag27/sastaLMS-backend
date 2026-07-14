import mongoose from "mongoose";
import crypto from "crypto";
import User from "../Models/userModel.js";
import OTP from "../Models/otpModel.js";
import { googleClient } from "../services/googleAuthService.js";
import { sendEmail } from "../services/email/sendEmailOtp.js";
import { getRedisClient } from "../config/redis.js";
import { sendOtpSchema, verifyOtpSchema } from "../validators/authSchema.js";
import { successResponse, errorResponse } from "../utils/response.js";

// SEND OTP
export const sendOtp = async (req, res) => {
  const { success, data, error } = sendOtpSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { email, purpose } = data;

  try {
    if (purpose === "REGISTER") {
      const existingUser = await User.findOne({ email }).lean();
      if (existingUser) return errorResponse(res, 409, "User already exists with this email");
    }

    if (purpose === "FORGOT_PASSWORD") {
      const existingUser = await User.findOne({ email }).lean();
      if (!existingUser) return errorResponse(res, 404, "No account found with this email");
    }

    if (purpose === "CHANGE_PASSWORD" || purpose === "SET_PASSWORD") {
      const { sid } = req.signedCookies;
      if (!sid) return errorResponse(res, 401, "Unauthorized");
      const redisClient = getRedisClient();
      const session = await redisClient.json.get(`session:${sid}`);
      if (!session?.userId) return errorResponse(res, 401, "Session expired or invalid");
      const user = await User.findById(session.userId).lean();
      if (!user) return errorResponse(res, 404, "User not found");
      if (user.email !== email) return errorResponse(res, 403, "Session email does not match requested email");
    }

    // Cooldown check (1 minute)
    const existingOtp = await OTP.findOne({ email, purpose });
    if (existingOtp) {
      const coolDownPeriod = new Date(existingOtp.createdAt).getTime() + 60000;
      if (Date.now() < coolDownPeriod) {
        return errorResponse(res, 429, "Please wait before requesting another OTP");
      }
    }

    const otp = crypto.randomInt(100000, 999999).toString();

    await OTP.findOneAndUpdate(
      { email, purpose },
      { email, otp, purpose, isVerified: false, expiresAt: new Date(Date.now() + 10 * 60 * 1000), createdAt: new Date() },
      { upsert: true }
    );

    const mailResult = await sendEmail(email, purpose, otp);
    if (!mailResult.success) {
      await OTP.findOneAndDelete({ email, purpose });
      return errorResponse(res, 500, mailResult.error);
    }

    return successResponse(res, 200, `OTP sent to ${email}`);
  } catch (err) {
    console.error("[sendOtp] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to send OTP. Please try again.");
  }
};

// VERIFY OTP
export const verifyOtp = async (req, res) => {
  const { success, data, error } = verifyOtpSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { email, otp, purpose } = data;

  try {
    if (purpose === "CHANGE_PASSWORD" || purpose === "SET_PASSWORD") {
      const { sid } = req.signedCookies;
      if (!sid) return errorResponse(res, 401, "Unauthorized");
      const redisClient = getRedisClient();
      const session = await redisClient.json.get(`session:${sid}`);
      if (!session?.userId) return errorResponse(res, 401, "Session expired or invalid");
      const user = await User.findById(session.userId).lean();
      if (!user) return errorResponse(res, 404, "User not found");
      if (user.email !== email) return errorResponse(res, 403, "Session email does not match requested email");
    }

    const isMatched = await OTP.findOne({ email, otp, purpose });
    if (!isMatched) return errorResponse(res, 400, "Invalid or expired OTP");

    const setQuery = { isVerified: true };
    if (purpose === "FORGOT_PASSWORD") {
      const existingUser = await User.findOne({ email });
      setQuery.isEmailRegistered = !!existingUser;
    }

    await OTP.findOneAndUpdate({ email, purpose, otp }, { $set: setQuery });
    return successResponse(res, 200, "OTP verified successfully");
  } catch (err) {
    console.error("[verifyOtp] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to verify OTP");
  }
};

// GOOGLE LOGIN / REGISTER
export const loginWithGoogle = async (req, res) => {
  const { idToken } = req.body;
  if (typeof idToken !== "string") return errorResponse(res, 400, "Invalid token");

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: googleClient._clientId,
    });

    const payload = ticket.getPayload();
    if (!payload?.email || !payload.email_verified) return errorResponse(res, 401, "Unverified Google account");

    let targetUser = await User.findOne({ email: payload.email });

    const redisClient = getRedisClient();

    if (!targetUser) {
      const userId = new mongoose.Types.ObjectId();
      targetUser = await User.create({ _id: userId, username: payload.name, email: payload.email });
    } else {
      if (targetUser.isBlocked) {
        return errorResponse(res, 403, "Your account has been banned. Please contact support if you believe this is a mistake");
      }

      const allSessions = await redisClient.ft.search("userIdIndex", `@userId:{${targetUser._id}}`, { RETURN: [] });
      if (allSessions.total >= 2) {
        await redisClient.del(allSessions.documents[0].id);
      }
    }

    const sessionId = crypto.randomUUID();
    await redisClient
      .multi()
      .json.set(`session:${sessionId}`, "$", {
        userId: targetUser._id,
        role: targetUser.role,
        isBlocked: targetUser.isBlocked,
        isPassAvailable: !!targetUser.password,
      })
      .expire(`session:${sessionId}`, 60 * 60 * 24 * 7)
      .exec();

    res.cookie("sid", sessionId, {
      httpOnly: true,
      signed: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    });

    return successResponse(res, 200, "User logged in");
  } catch (err) {
    console.error("[loginWithGoogle] Unexpected error:", err);
    return errorResponse(res, 500, "Google login failed. Please try again.");
  }
};
