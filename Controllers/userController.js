import User from "../Models/userModel.js";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import OTP from "../Models/otpModel.js";
import { redisClient } from "../config/redis.js";
import {
  changePassSchema,
  loginSchema,
  registerSchema,
  verifyChangeEmailSchema,
} from "../validators/authSchema.js";
import { NOTIFICATION_TYPES } from "../config/notificationTypes.js";
import { createNotification } from "../services/notificationService.js";
import { sendWelcomeEmail } from "../services/email/sendWelcomeEmail.js";

//REGISTER
export const Register = async (req, res, next) => {
  const { success, data, error } = registerSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({ error: error.issues[0].message });
  }
  const { username, email, password, otp } = data;

  const isOtpAvailable = await OTP.findOne({ email, otp });

  if (!isOtpAvailable) {
    return res.status(400).json({ error: "Invalid or Expired OTP!!" });
  }

  const session = await mongoose.startSession();

  const hashedPassword = await bcrypt.hash(password, 11);

  try {
    const userId = new mongoose.Types.ObjectId();

    await User.create({
      _id: userId,
      username,
      email,
      password: hashedPassword,
    });

    await sendWelcomeEmail(email, username, userId.toString());

    await isOtpAvailable.deleteOne();
    res.status(201).json({ message: "User Registered" });
  } catch (error) {
    if (error.code === 121) {
      res.status(400).json({ error: "Invalid fields" });
      console.error("Registration error:", JSON.stringify(error, null, 2));
    } else if (error.code === 11000 && error.keyValue.email) {
      console.log(error);
      return res
        .status(409)
        .json({ error: "User Already Exist With This Email" });
    } else if (error.code === 11000 && error.keyValue.username) {
      console.log(error);
      return res
        .status(409)
        .json({ error: "User Already Exist With This Username" });
    } else {
      console.log(error);
      next(error);
    }
  }
};

//LOGIN
export const Login = async (req, res) => {
  const { success, data, error } = loginSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({ error: error.issues[0].message });
  }

  const { email, password } = data;

  const user = await User.findOne({ email }).lean();

  if (!user) {
    return res
      .status(401)
      .json({ error: "User not registered", redirect: true });
  }

  if (user.isBlocked) {
    return res.status(403).json({
      message:
        "Your account has been banned. Please contact support if you believe this is a mistake",
    });
  }

  if (!user.password) {
    return res
      .status(400)
      .json({ error: "Password not set. Please use Google login." });
  }

  const isAuthenticated = await bcrypt.compare(password, user.password);

  if (!isAuthenticated) {
    return res.status(401).json({ error: "Invalid Credentials" });
  }

  const allSessions = await redisClient.ft.search(
    "userIdIndex",
    `@userId:{${user._id}}`,
    {
      RETURN: [],
    },
  );

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
  res.status(200).json({ message: "User logged in" });
};

//GET USERNAME, EMAIL AND DASHBOARD VALIDATION
export const CheckUserName = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const isPassAvailable = req.user.isPassAvailable;

    const redisKey = `profile:${userId}`;

    const cached = await redisClient.json.get(redisKey);

    if (cached) {
      return res.status(200).json(cached);
    }

    const user = await User.findById(userId)
      .select("username email role planId bandwidthUsedBytes")
      .lean();

    await redisClient
      .multi()
      .json.set(redisKey, "$", user)
      .json.set(redisKey, "$.isPassAvailable", isPassAvailable)
      .json.set(redisKey, "$.usedSpaceInBytes", 0)
      .expire(redisKey, 600)
      .exec();

    const response = {
      ...user,
      isPassAvailable,
      usedSpaceInBytes: 0,
    };

    res.status(200).json(response);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

//LOGOUT
export const Logout = async (req, res) => {
  try {
    const { sid } = req.signedCookies;
    await redisClient.json.del(`session:${sid}`);
    await redisClient.json.del(`profile:${req.user._id}`);

    res.clearCookie("sid", {
      httpOnly: true,
    });

    res.status(200).json({ message: "User Logged Out" });
  } catch (error) {
    res.status(500).json({ error: "Failed to logout" });
  }
};

//LOGOUT ALL DEVICES
export const LogoutAllDevices = async (req, res) => {
  try {
    const data = await redisClient.ft.search(
      "userIdIndex",
      `@userId:{${req.user._id}}`,
    );

    if (!data.documents.length) {
      return res.status(404).json({ error: "No session found" });
    }

    const keys = data.documents.map((elem) => elem.id);

    await redisClient.del(keys);
    await redisClient.json.del(`profile:${req.user._id}`);

    res.clearCookie("sid", {
      httpOnly: true,
    });

    res.status(200).json({ message: "User Logged Out from all devices" });
  } catch (error) {
    res.status(500).json({ error: "Failed to logout from all devices" });
  }
};

//CHANGE PASSWORD
export const changePass = async (req, res) => {
  const { success, data, error } = changePassSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({ error: error.issues[0].message });
  }

  const { newPassword, oldPassword } = data;

  const user = await User.findById(req.user._id);

  if (!user) {
    return res.status(400).json({ error: "User not found" });
  }

  const userHasHashedPassword = !!user.password;

  if (userHasHashedPassword) {
    if (!oldPassword) {
      return res.status(400).json({ error: "Old password is required" });
    }

    const isAuthenticated = await bcrypt.compare(oldPassword, user.password);

    if (!isAuthenticated) {
      return res
        .status(401)
        .json({ error: "You have entered a wrong password" });
    }
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 11);
    user.password = hashedPassword;
    await user.save();

    const data = await redisClient.ft.search(
      "userIdIndex",
      `@userId:{${req.user._id}}`,
    );

    if (!data.documents.length) {
      return res.status(204).json({ error: "No session found" });
    }

    const keys = data.documents.map((elem) => elem.id);

    await redisClient.del(keys);
    await redisClient.json.del(`profile:${req.user._id}`);

    res.clearCookie("sid", {
      httpOnly: true,
    });

    await createNotification({
      userId: req.user._id,
      type: NOTIFICATION_TYPES.PASSWORD_CHANGED,
      title: "Password changed",
      message: "Your account password was changed",
      metadata: {},
      group: false,
    });

    res.json({ message: "Password changed successfully", success: true });
  } catch (error) {
    res.status(400).json({ error: "Failed to change Password" });
  }
};

//CHANGE EMAIL ID
export const changeEmail = async (req, res) => {
  const { success, data, error } = verifyChangeEmailSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({ error: error.issues[0].message });
  }

  const { newEmail, oldEmailOtp, newEmailOtp, password } = data;

  try {
    const userInfo = await User.findById(req.user._id);
    if (!userInfo) {
      return res.status(404).json({ error: "User not found" });
    }

    if (userInfo.email === newEmail) {
      return res.status(400).json({
        error: "New email must be different from current email",
      });
    }

    const emailExists = await User.findOne({ email: newEmail });
    if (emailExists) {
      return res.status(409).json({
        error: "Email already in use",
      });
    }

    const otpInfo = await OTP.findOne({
      email: userInfo.email,
      newEmail,
      otp: oldEmailOtp,
      newEmailOtp,
      purpose: "security",
    });

    if (!otpInfo) {
      return res.status(400).json({
        error: "Invalid or expired OTP",
      });
    }

    const isAuthenticated = await bcrypt.compare(password, userInfo.password);

    if (!isAuthenticated) {
      return res.status(401).json({
        error: "Incorrect password",
      });
    }

    await User.findByIdAndUpdate(req.user._id, {
      $set: { email: newEmail },
    });

    await OTP.deleteOne({ _id: otpInfo._id });

    await createNotification({
      userId: req.user._id,
      type: NOTIFICATION_TYPES.EMAIL_CHANGED,
      title: "Email changed",
      message: "Your account's email id was changed",
      metadata: {},
      group: false,
    });

    return res.status(200).json({
      success: true,
      message: "Email changed successfully",
    });
  } catch (err) {
    return res.status(500).json({
      error: "Failed to change email",
    });
  }
};
