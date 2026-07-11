import mongoose from "mongoose";
import User from "../Models/userModel.js";
import Course from "../Models/courseModel.js";
import Enrollment from "../Models/enrollmentModel.js";
import LessonProgress from "../Models/lessonProgressModel.js";
import OTP from "../Models/otpModel.js";
import Media from "../Models/mediaModel.js";
import { redisClient } from "../config/redis.js";

// Regex matching the project's existing ObjectId validation convention
const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

/**
 * Validates that an administrator has the authority to manage a target user.
 *
 * Enforces:
 *   1. Actor cannot target themselves for administrative operations.
 *   2. Actor cannot target a user of equal or higher rank (RBAC boundary).
 *
 * @param {object} actor - The acting user object (req.user)
 * @param {object} target - The target user document from DB
 * @throws {{ isOperational: boolean, statusCode: number, message: string }} Custom operational error
 */
export const assertAdminCanManageUser = (actor, target) => {
  if (actor._id.toString() === target._id.toString()) {
    throw {
      isOperational: true,
      statusCode: 403,
      message: "You cannot perform administrative operations on yourself",
    };
  }

  // Only STUDENT accounts are manageable through administrative user-management endpoints.
  // CREATOR accounts cannot be blocked, deleted, force-logged-out, or managed this way.
  if (target.role !== "STUDENT") {
    throw {
      isOperational: true,
      statusCode: 403,
      message: "Administrative user-management operations can only target STUDENT accounts",
    };
  }
};

/**
 * Shared helper to invalidate all Redis sessions for a user.
 *
 * @param {string} userId
 * @returns {Promise<number>} Number of sessions invalidated
 */
export const invalidateUserSessions = async (userId) => {
  try {
    const data = await redisClient.ft.search("userIdIndex", `@userId:{${userId}}`);
    const keys = data.documents.map((elem) => elem.id);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
    return keys.length;
  } catch (err) {
    console.error(`[invalidateUserSessions] Failed to invalidate sessions for user ${userId}:`, err);
    return 0;
  }
};

/**
 * Shared helper to invalidate the user profile cache in Redis.
 *
 * @param {string} userId
 */
export const invalidateUserProfileCache = async (userId) => {
  try {
    await redisClient.del(`profile:${userId}`);
  } catch (err) {
    console.error(`[invalidateUserProfileCache] Failed to delete profile cache for user ${userId}:`, err);
  }
};

/**
 * Service orchestrator for safe user deletion.
 *
 * Enforces business invariants:
 *   1. Reject creator deletion when they still own courses.
 *   2. Deletes dependent Enrollments, LessonProgress, OTPs, and orphaned Media.
 *   3. Preserves Payment history (financial records) to prevent null/broken records.
 *   4. Cleans up Redis sessions and profile caches.
 *   5. Employs MongoDB transactions when replica sets are available.
 *
 * @param {string} userId - Target user ID to delete
 * @returns {Promise<{ success: boolean, role: string, sessionsInvalidated: number }>}
 */
export const deleteUser = async (userId) => {
  const user = await User.findById(userId);
  if (!user) {
    throw { isOperational: true, statusCode: 404, message: "User not found" };
  }

  const role = user.role;

  // 1. Enforce Creator Preconditions
  // Note: Only STUDENT accounts are reachable via administrative delete (assertAdminCanManageUser
  // already rejects CREATOR targets), but this guard is kept as a defense-in-depth safety net.
  if (role === "CREATOR") {
    const ownedCoursesCount = await Course.countDocuments({ creator: userId });
    if (ownedCoursesCount > 0) {
      throw {
        isOperational: true,
        statusCode: 400,
        message: "Cannot delete a creator who still owns courses. Delete or transfer courses first.",
      };
    }
  }

  // 2. Start Session for Transaction (if replica set is supported/configured)
  const mongooseSession = await mongoose.startSession().catch(() => null);
  if (mongooseSession) {
    mongooseSession.startTransaction();
  }

  let sessionsInvalidated = 0;

  try {
    // 3. Destructive MongoDB operations (dependent student learning data & OTPs)
    const options = mongooseSession ? { session: mongooseSession } : {};

    await Enrollment.deleteMany({ user: userId }, options);
    await LessonProgress.deleteMany({ user: userId }, options);
    await OTP.deleteMany({ email: user.email }, options);
    await Media.deleteMany({ uploadedBy: userId }, options);

    // Hard deletion of the User document itself
    await User.findByIdAndDelete(userId, options);

    if (mongooseSession) {
      await mongooseSession.commitTransaction();
      mongooseSession.endSession();
    }
  } catch (err) {
    if (mongooseSession) {
      await mongooseSession.abortTransaction();
      mongooseSession.endSession();
    }
    throw err;
  }

  // 4. Redis Invalidation (executed outside DB transaction to prevent distributed locking)
  sessionsInvalidated = await invalidateUserSessions(userId);
  await invalidateUserProfileCache(userId);

  return {
    success: true,
    role,
    sessionsInvalidated,
  };
};
