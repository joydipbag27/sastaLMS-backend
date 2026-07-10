import User from "../Models/userModel.js";
import Course from "../Models/courseModel.js";
import mongoose from "mongoose";
import { redisClient } from "../config/redis.js";
import { roleDataSchema } from "../validators/authSchema.js";
import { successResponse, errorResponse } from "../utils/response.js";
import {
  deleteUser,
  assertAdminCanManageUser,
  invalidateUserSessions,
  invalidateUserProfileCache,
} from "../services/userDeletionService.js";

// GET ALL USERS
export const getAllUsers = async (req, res) => {
  const ownId = req.user._id;
  const { cursor } = req.query;

  // Validate and clamp limit to be safe from negative/NaN/Infinity values
  let limit = Math.max(1, Math.min(parseInt(req.query.limit) || 10, 50));

  if (cursor && !mongoose.isValidObjectId(cursor)) {
    return errorResponse(res, 400, "Invalid cursor");
  }

  // Exclude current user and apply cursor filter
  const query = { _id: { $ne: ownId } };
  if (cursor) query._id = { ...query._id, $lt: cursor };

  try {
    // Fetch limit + 1 documents to determine if there's a next page accurately
    const allUsers = await User.find(query)
      .select("username _id email role isBlocked createdAt")
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = allUsers.length > limit;
    const users = hasMore ? allUsers.slice(0, limit) : allUsers;
    const nextCursor = hasMore ? users[users.length - 1]._id : null;

    return successResponse(res, 200, "Users fetched", {
      users,
      nextCursor,
      hasMore,
    });
  } catch (err) {
    console.error("[getAllUsers] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch users");
  }
};

// GET USER SESSION STATUS
export const getSessionStatus = async (req, res) => {
  const { id: userId } = req.params;

  if (!userId) return errorResponse(res, 400, "User ID required");
  if (!mongoose.isValidObjectId(userId)) return errorResponse(res, 400, "Invalid userId");

  try {
    const targetUser = await User.findById(userId);
    if (!targetUser) return errorResponse(res, 404, "User not found");

    // Admins cannot inspect equal or higher rank users
    try {
      assertAdminCanManageUser(req.user, targetUser);
    } catch (err) {
      if (err.isOperational) {
        return errorResponse(res, err.statusCode, err.message);
      }
      throw err;
    }

    const session = await redisClient.ft.search("userIdIndex", `@userId:{${userId}}`);
    return successResponse(res, 200, "Session status fetched", { isLoggedIn: session.total > 0 });
  } catch (err) {
    console.error("[getSessionStatus] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to get session status");
  }
};

// ADMIN LOGOUT (Force Logout)
export const adminLogout = async (req, res) => {
  const { userId } = req.body;
  if (!mongoose.isValidObjectId(userId)) return errorResponse(res, 400, "Invalid userId");

  try {
    const targetUser = await User.findById(userId);
    if (!targetUser) return errorResponse(res, 404, "User not found");

    // Prevent self-targeting and hierarchy violations
    try {
      assertAdminCanManageUser(req.user, targetUser);
    } catch (err) {
      if (err.isOperational) {
        return errorResponse(res, err.statusCode, err.message);
      }
      throw err;
    }

    const sessionsInvalidated = await invalidateUserSessions(userId);
    await invalidateUserProfileCache(userId);

    return successResponse(res, 200, "User logged out successfully", {
      userId,
      sessionsInvalidated,
    });
  } catch (err) {
    console.error("[adminLogout] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to logout user");
  }
};

// ADMIN DELETE
export const adminDelete = async (req, res) => {
  const { userId } = req.body;
  if (!mongoose.isValidObjectId(userId)) return errorResponse(res, 400, "Invalid userId");

  try {
    const targetUser = await User.findById(userId);
    if (!targetUser) return errorResponse(res, 404, "User not found");

    // Prevent self-deletion and hierarchy violations
    try {
      assertAdminCanManageUser(req.user, targetUser);
    } catch (err) {
      if (err.isOperational) {
        return errorResponse(res, err.statusCode, err.message);
      }
      throw err;
    }

    const result = await deleteUser(userId);

    return successResponse(res, 200, "User deleted successfully", {
      userId,
      role: result.role,
      sessionsInvalidated: result.sessionsInvalidated,
    });
  } catch (err) {
    if (err.isOperational) {
      return errorResponse(res, err.statusCode, err.message);
    }
    console.error("[adminDelete] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to delete user");
  }
};

// ADMIN BLOCK / UNBLOCK
export const adminBlock = async (req, res) => {
  const { userId, isBlocked } = req.body;
  if (!mongoose.isValidObjectId(userId)) return errorResponse(res, 400, "Invalid userId");

  try {
    const targetUser = await User.findById(userId);
    if (!targetUser) return errorResponse(res, 404, "User not found");

    // Prevent self-blocking and hierarchy violations
    try {
      assertAdminCanManageUser(req.user, targetUser);
    } catch (err) {
      if (err.isOperational) {
        return errorResponse(res, err.statusCode, err.message);
      }
      throw err;
    }

    const targetBlockedState = typeof isBlocked === "boolean" ? isBlocked : !targetUser.isBlocked;

    // Idempotent check
    if (targetUser.isBlocked === targetBlockedState) {
      return successResponse(res, 200, `${targetUser.username} is already ${targetBlockedState ? "blocked" : "unblocked"}`, {
        userId,
        isBlocked: targetUser.isBlocked,
      });
    }

    if (targetBlockedState) {
      // Blocking: force-logout all active sessions
      await invalidateUserSessions(userId);
      await invalidateUserProfileCache(userId);
    }

    targetUser.isBlocked = targetBlockedState;
    await targetUser.save();

    return successResponse(res, 200, `${targetUser.username} has been ${targetBlockedState ? "blocked" : "unblocked"}`, {
      userId,
      isBlocked: targetUser.isBlocked,
    });
  } catch (err) {
    console.error("[adminBlock] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to update user block status");
  }
};

// CHANGE ROLE
export const changeRole = async (req, res) => {
  const ownRole = req.user.role;
  const { success, data, error } = roleDataSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { userId, changeTo } = data;

  try {
    const targetUser = await User.findById(userId);
    if (!targetUser) return errorResponse(res, 404, "User not found");

    // Enforce target rules: no self-targeting, no managing equal/higher-rank users
    try {
      assertAdminCanManageUser(req.user, targetUser);
    } catch (err) {
      if (err.isOperational) {
        return errorResponse(res, err.statusCode, err.message);
      }
      throw err;
    }

    if (ownRole !== "ADMIN") return errorResponse(res, 403, "Insufficient permissions");

    const roleRank = { STUDENT: 1, CREATOR: 2, ADMIN: 3 };

    if (roleRank[changeTo] > roleRank[ownRole]) {
      return errorResponse(res, 403, "Cannot assign a role higher than your own");
    }

    // Idempotency check
    if (targetUser.role === changeTo) {
      return successResponse(res, 200, "User role is already set to the requested value", {
        userId,
        role: targetUser.role,
      });
    }

    // Demotion Precondition: CREATOR -> STUDENT
    if (targetUser.role === "CREATOR" && changeTo === "STUDENT") {
      const ownedCoursesCount = await Course.countDocuments({ creator: userId });
      if (ownedCoursesCount > 0) {
        return errorResponse(res, 400, "Cannot demote a creator who still owns courses. Delete or transfer courses first.");
      }
    }

    targetUser.role = changeTo;
    await targetUser.save();

    // Invalidate profile cache and force re-login for new role to take effect
    await invalidateUserProfileCache(userId);
    await invalidateUserSessions(userId);

    return successResponse(res, 200, "User role updated successfully", {
      userId,
      role: targetUser.role,
    });
  } catch (err) {
    console.error("[changeRole] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to update user role");
  }
};
