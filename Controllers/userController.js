import User from "../Models/userModel.js";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import OTP from "../Models/otpModel.js";
import { getRedisClient } from "../config/redis.js";
import {
  changePassSchema,
  loginSchema,
  registerSchema,
  forgotPassSchema,
  setNewPassSchema,
} from "../validators/authSchema.js";
import { sendWelcomeEmail } from "../services/email/sendWelcomeEmail.js";
import { successResponse, errorResponse } from "../utils/response.js";

// REGISTER
export const Register = async (req, res) => {
  const { success, data, error } = registerSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { username, email, password } = data;

  const isOtpVerified = await OTP.findOne({ email, purpose: "REGISTER", isVerified: true });
  if (!isOtpVerified) return errorResponse(res, 400, "Please verify your email first!");

  try {
    const hashedPassword = await bcrypt.hash(password, 11);
    const userId = new mongoose.Types.ObjectId();

    await User.create({ _id: userId, username, email, password: hashedPassword });
    await sendWelcomeEmail(email, username, userId.toString());
    await isOtpVerified.deleteOne();

    return successResponse(res, 201, "User registered successfully");
  } catch (err) {
    if (err.code === 11000 && err.keyValue?.email) {
      return errorResponse(res, 409, "User already exists with this email");
    }
    if (err.code === 11000 && err.keyValue?.username) {
      return errorResponse(res, 409, "User already exists with this username");
    }
    console.error("[Register] Unexpected error:", err);
    return errorResponse(res, 500, "Registration failed. Please try again.");
  }
};

// LOGIN
export const Login = async (req, res) => {
  const { success, data, error } = loginSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { email, password } = data;

  try {
    const user = await User.findOne({ email }).lean();
    if (!user) return errorResponse(res, 401, "No account found with this email");
    if (user.isBlocked) return errorResponse(res, 403, "Your account has been banned. Please contact support if you believe this is a mistake");
    if (!user.password) return errorResponse(res, 400, "Password not set. Please use Google login.");

    const isAuthenticated = await bcrypt.compare(password, user.password);
    if (!isAuthenticated) return errorResponse(res, 401, "Invalid credentials");

    const redisClient = getRedisClient();
    const allSessions = await redisClient.ft.search("userIdIndex", `@userId:{${user._id}}`, { RETURN: [] });
    if (allSessions.total >= 2) {
      await redisClient.del(allSessions.documents[0].id);
    }

    const sessionId = crypto.randomUUID();
    await redisClient
      .multi()
      .json.set(`session:${sessionId}`, "$", {
        userId: user._id,
        rootDirId: user.rootDirId,
        role: user.role,
        isBlocked: user.isBlocked,
        isPassAvailable: !!user.password,
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
    console.error("[Login] Unexpected error:", err);
    return errorResponse(res, 500, "Login failed. Please try again.");
  }
};

// GET CURRENT USER
export const CheckUserName = async (req, res) => {
  try {
    const userId = req.user._id;
    const isPassAvailable = req.user.isPassAvailable;

    const redisKey = `profile:${userId}`;
    const redisClient = getRedisClient();
    const cached = await redisClient.json.get(redisKey);
    if (cached) return successResponse(res, 200, "User fetched", cached);

    const user = await User.findById(userId).select("username email role").lean();

    await redisClient
      .multi()
      .json.set(redisKey, "$", user)
      .json.set(redisKey, "$.isPassAvailable", isPassAvailable)
      .json.set(redisKey, "$.usedSpaceInBytes", 0)
      .expire(redisKey, 600)
      .exec();

    const response = { ...user, isPassAvailable, usedSpaceInBytes: 0 };
    return successResponse(res, 200, "User fetched", response);
  } catch (err) {
    console.error("[CheckUserName] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch user");
  }
};

// LOGOUT
export const Logout = async (req, res) => {
  try {
    const { sid } = req.signedCookies;
    const redisClient = getRedisClient();
    await redisClient.json.del(`session:${sid}`);
    await redisClient.json.del(`profile:${req.user._id}`);
    res.clearCookie("sid", { httpOnly: true });
    return successResponse(res, 200, "Logged out successfully");
  } catch (err) {
    console.error("[Logout] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to logout");
  }
};

// LOGOUT ALL DEVICES
export const LogoutAllDevices = async (req, res) => {
  try {
    const redisClient = getRedisClient();
    const data = await redisClient.ft.search("userIdIndex", `@userId:{${req.user._id}}`);
    if (!data.documents.length) return errorResponse(res, 404, "No active sessions found");

    const keys = data.documents.map((elem) => elem.id);
    await redisClient.del(keys);
    await redisClient.json.del(`profile:${req.user._id}`);
    res.clearCookie("sid", { httpOnly: true });
    return successResponse(res, 200, "Logged out from all devices");
  } catch (err) {
    console.error("[LogoutAllDevices] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to logout from all devices");
  }
};

// CHANGE PASSWORD
export const changePass = async (req, res) => {
  const { success, data, error } = changePassSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { newPassword, oldPassword } = data;

  try {
    const user = await User.findById(req.user._id);
    if (!user) return errorResponse(res, 404, "User not found");
    if (!user.password) return errorResponse(res, 400, "This account does not have a password");

    const otpInfo = await OTP.findOne({ email: user.email, purpose: "CHANGE_PASSWORD", isVerified: true });
    if (!otpInfo) return errorResponse(res, 403, "Please verify your email first!");

    const isAuthenticated = await bcrypt.compare(oldPassword, user.password);
    if (!isAuthenticated) return errorResponse(res, 401, "Old password is incorrect");

    const hashedPassword = await bcrypt.hash(newPassword, 11);
    user.password = hashedPassword;
    await user.save();

    const redisClient = getRedisClient();
    const sessions = await redisClient.ft.search("userIdIndex", `@userId:{${req.user._id}}`);
    if (sessions.documents.length) {
      await redisClient.del(sessions.documents.map((e) => e.id));
    }
    await redisClient.json.del(`profile:${req.user._id}`);
    await otpInfo.deleteOne();
    res.clearCookie("sid", { httpOnly: true });

    return successResponse(res, 200, "Password changed successfully");
  } catch (err) {
    console.error("[changePass] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to change password");
  }
};

// FORGOT PASSWORD
export const forgotPassword = async (req, res) => {
  const { success, data, error } = forgotPassSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { email, newPassword } = data;

  try {
    const otpInfo = await OTP.findOne({ email, purpose: "FORGOT_PASSWORD", isVerified: true });
    if (!otpInfo) return errorResponse(res, 403, "Please verify your email first!");
    if (!otpInfo.isEmailRegistered) return errorResponse(res, 403, "Cannot change the password of an unregistered email");

    const user = await User.findOne({ email });
    if (!user) return errorResponse(res, 404, "User not found");

    const hashedPassword = await bcrypt.hash(newPassword, 11);
    user.password = hashedPassword;
    await user.save();

    const redisClient = getRedisClient();
    const sessions = await redisClient.ft.search("userIdIndex", `@userId:{${user._id}}`);
    if (sessions.documents.length) {
      await redisClient.del(sessions.documents.map((e) => e.id));
    }
    await redisClient.json.del(`profile:${user._id}`);
    await otpInfo.deleteOne();

    return successResponse(res, 200, "Password reset successfully");
  } catch (err) {
    console.error("[forgotPassword] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to reset password");
  }
};

// SET NEW PASSWORD (Google users)
export const setNewPass = async (req, res) => {
  const { success, data, error } = setNewPassSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { newPassword } = data;

  try {
    const user = await User.findById(req.user._id);
    if (!user) return errorResponse(res, 404, "User not found");
    if (user.password) return errorResponse(res, 400, "You already have a password set");

    const otpInfo = await OTP.findOne({ email: user.email, purpose: "SET_PASSWORD", isVerified: true });
    if (!otpInfo) return errorResponse(res, 403, "Please verify your email first!");

    const hashedPassword = await bcrypt.hash(newPassword, 11);
    user.password = hashedPassword;
    await user.save();

    const redisClientInstance = getRedisClient();
    const sessions = await redisClientInstance.ft.search("userIdIndex", `@userId:{${req.user._id}}`);
    if (sessions.documents.length) {
      await redisClientInstance.del(sessions.documents.map((e) => e.id));
    }
    await redisClientInstance.json.del(`profile:${req.user._id}`);
    await otpInfo.deleteOne();
    res.clearCookie("sid", { httpOnly: true });

    return successResponse(res, 200, "Password set successfully");
  } catch (err) {
    console.error("[setNewPass] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to set password");
  }
};
