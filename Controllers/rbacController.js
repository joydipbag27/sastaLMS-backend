import User from "../Models/userModel.js";
import Course from "../Models/courseModel.js";
import Enrollment from "../Models/enrollmentModel.js";
import Payment from "../Models/paymentModel.js";
import { razorpayInstance } from "../config/razorpay.js";
import mongoose from "mongoose";
import { redisClient } from "../config/redis.js";
import { successResponse, errorResponse } from "../utils/response.js";
import {
  deleteUser,
  assertAdminCanManageUser,
  invalidateUserSessions,
  invalidateUserProfileCache,
} from "../services/userDeletionService.js";

// GET DASHBOARD SUMMARY
export const getAdminDashboardSummary = async (req, res) => {
  try {
    const [
      totalUsers,
      enrolledUserIds,
      totalEnrollments,
      totalCourses,
      publishedCourses,
      draftCourses,
      blockedUsers,
    ] = await Promise.all([
      User.countDocuments({}),
      Enrollment.distinct("user", { status: "Active" }),
      Enrollment.countDocuments({ status: "Active" }),
      Course.countDocuments({}),
      Course.countDocuments({ status: "Published" }),
      Course.countDocuments({ status: "Draft" }),
      User.countDocuments({ isBlocked: true }),
    ]);

    const enrolledUsers = enrolledUserIds.length;

    return successResponse(res, 200, "Admin dashboard summary fetched successfully", {
      totalUsers,
      enrolledUsers,
      totalEnrollments,
      totalCourses,
      publishedCourses,
      draftCourses,
      blockedUsers,
    });
  } catch (err) {
    console.error("[getAdminDashboardSummary] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch admin dashboard summary");
  }
};

// GET PAYMENT SUMMARY
export const getAdminPaymentSummary = async (req, res) => {
  try {
    const now = new Date();
    // Using UTC consistently for calendar month boundaries
    const startOfCurrentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const startOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const [
      revenueResult,
      monthlyResult,
      totalSuccessfulPayments,
      totalPaymentAttempts,
    ] = await Promise.all([
      // Total Revenue sum
      Payment.aggregate([
        { $match: { status: "Paid" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // Current Calendar Month Revenue
      Payment.aggregate([
        {
          $match: {
            status: "Paid",
            updatedAt: {
              $gte: startOfCurrentMonth,
              $lt: startOfNextMonth,
            },
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // Count of successful payments
      Payment.countDocuments({ status: "Paid" }),
      // Count of total attempts (all Payment documents)
      Payment.countDocuments({}),
    ]);

    const totalRevenue = revenueResult[0]?.total ?? 0;
    const monthlyRevenue = monthlyResult[0]?.total ?? 0;

    return successResponse(res, 200, "Admin payment summary fetched successfully", {
      totalRevenue,
      monthlyRevenue,
      totalSuccessfulPayments,
      totalPaymentAttempts,
    });
  } catch (err) {
    console.error("[getAdminPaymentSummary] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch admin payment summary");
  }
};

// GET COURSE-WISE REVENUE
export const getRevenueByCourse = async (req, res) => {
  try {
    // Validate limit and fallback safely
    let limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 100));

    const coursesRevenue = await Payment.aggregate([
      { $match: { status: "Paid" } },
      {
        $group: {
          _id: "$course",
          revenue: { $sum: "$amount" },
          successfulPayments: { $sum: 1 },
        },
      },
      {
        $sort: {
          revenue: -1,
          _id: 1, // deterministic tie-breaker
        },
      },
      { $limit: limit },
      {
        $lookup: {
          from: "courses",
          localField: "_id",
          foreignField: "_id",
          as: "courseInfo",
        },
      },
      {
        $project: {
          _id: 0,
          courseId: "$_id",
          revenue: 1,
          successfulPayments: 1,
          title: { $ifNull: [{ $arrayElemAt: ["$courseInfo.title", 0] }, "Deleted Course"] },
        },
      },
    ]);

    return successResponse(res, 200, "Course revenue fetched successfully", {
      courses: coursesRevenue,
    });
  } catch (err) {
    console.error("[getRevenueByCourse] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch course revenue data");
  }
};

// GET SUCCESSFUL PAYMENT HISTORY (Cursor Paginated)
export const getSuccessfulPayments = async (req, res) => {
  try {
    let limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 50));
    const { cursor } = req.query;

    if (cursor && !mongoose.isValidObjectId(cursor)) {
      return errorResponse(res, 400, "Invalid cursor");
    }

    const query = { status: "Paid" };
    if (cursor) {
      query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    const payments = await Payment.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate("user", "username email")
      .populate("course", "title")
      .lean();

    const hasMore = payments.length > limit;
    const results = hasMore ? payments.slice(0, limit) : payments;
    const nextCursor = hasMore && results.length > 0 ? results[results.length - 1]._id : null;

    const sanitizedPayments = results.map((p) => ({
      _id: p._id,
      amount: p.amount,
      currency: "INR",
      status: p.status,
      razorpayOrderId: p.razorpayOrderId,
      razorpayPaymentId: p.razorpayPaymentId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      user: p.user
        ? {
            _id: p.user._id,
            username: p.user.username,
            email: p.user.email,
          }
        : null,
      course: p.course
        ? {
            _id: p.course._id,
            title: p.course.title,
          }
        : null,
    }));

    return successResponse(res, 200, "Successful payments fetched successfully", {
      payments: sanitizedPayments,
      nextCursor,
      hasMore,
    });
  } catch (err) {
    console.error("[getSuccessfulPayments] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch successful payments history");
  }
};

// ON-DEMAND INVOICE FETCH FOR A SPECIFIC SUCCESSFUL PAYMENT
export const getPaymentInvoice = async (req, res) => {
  try {
    const { paymentId } = req.params;

    if (!paymentId || !mongoose.isValidObjectId(paymentId)) {
      return errorResponse(res, 400, "Invalid paymentId");
    }

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return errorResponse(res, 404, "Payment record not found");
    }

    if (payment.status !== "Paid") {
      return errorResponse(res, 400, "Invoice is only available for successful payments");
    }

    if (!payment.razorpayPaymentId) {
      return errorResponse(res, 404, "Payment gateway identifier missing on payment record");
    }

    try {
      // Retrieve payment entity from Razorpay to obtain the invoice_id
      const rpPayment = await razorpayInstance.payments.fetch(payment.razorpayPaymentId);
      if (rpPayment && rpPayment.invoice_id) {
        // Retrieve details of the associated invoice
        const invoice = await razorpayInstance.invoices.fetch(rpPayment.invoice_id);
        return successResponse(res, 200, "Invoice fetched successfully", {
          invoiceId: invoice.id,
          invoiceUrl: invoice.short_url || invoice.invoice_url || null,
        });
      }
      return errorResponse(res, 404, "No invoice has been generated for this payment");
    } catch (rpErr) {
      console.error("[getPaymentInvoice] Razorpay API call failed:", rpErr);
      return errorResponse(res, 502, "Failed to retrieve invoice from payment gateway");
    }
  } catch (err) {
    console.error("[getPaymentInvoice] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to retrieve invoice details");
  }
};

// GET ALL MANAGEABLE USERS (STUDENT accounts only)
export const getAllUsers = async (req, res) => {
  const ownId = req.user._id;
  const { cursor } = req.query;

  // Validate and clamp limit to be safe from negative/NaN/Infinity values
  let limit = Math.max(1, Math.min(parseInt(req.query.limit) || 10, 50));

  if (cursor && !mongoose.isValidObjectId(cursor)) {
    return errorResponse(res, 400, "Invalid cursor");
  }

  // Return only STUDENT accounts — CREATOR accounts are not manageable via these endpoints
  const query = { _id: { $ne: ownId }, role: "STUDENT" };
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

    // Ensure target is a manageable STUDENT account
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

// FORCE LOGOUT (admin action)
export const adminLogout = async (req, res) => {
  const { userId } = req.body;
  if (!mongoose.isValidObjectId(userId)) return errorResponse(res, 400, "Invalid userId");

  try {
    const targetUser = await User.findById(userId);
    if (!targetUser) return errorResponse(res, 404, "User not found");

    // Prevent self-targeting and ensure target is a STUDENT
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

// DELETE USER (CREATOR-authorized, STUDENT targets only)
export const adminDelete = async (req, res) => {
  const { userId } = req.body;
  if (!mongoose.isValidObjectId(userId)) return errorResponse(res, 400, "Invalid userId");

  try {
    const targetUser = await User.findById(userId);
    if (!targetUser) return errorResponse(res, 404, "User not found");

    // Prevent self-deletion and ensure target is a STUDENT
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

// BLOCK / UNBLOCK
export const adminBlock = async (req, res) => {
  const { userId, isBlocked } = req.body;
  if (!mongoose.isValidObjectId(userId)) return errorResponse(res, 400, "Invalid userId");

  try {
    const targetUser = await User.findById(userId);
    if (!targetUser) return errorResponse(res, 404, "User not found");

    // Prevent self-blocking and ensure target is a STUDENT
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

// PROMOTE STUDENT → CREATOR
// The only allowed role transition through the administration API.
// Promotion is irreversible through the normal API.
export const promoteToCreator = async (req, res) => {
  const { userId } = req.params;

  if (!mongoose.isValidObjectId(userId)) {
    return errorResponse(res, 400, "Invalid userId");
  }

  try {
    const targetUser = await User.findById(userId);
    if (!targetUser) return errorResponse(res, 404, "User not found");

    // Prevent self-promotion
    if (req.user._id.toString() === targetUser._id.toString()) {
      return errorResponse(res, 403, "You cannot promote yourself");
    }

    // Only STUDENT → CREATOR is allowed
    if (targetUser.role !== "STUDENT") {
      return errorResponse(res, 400, "Target user is already a CREATOR. Promotion is irreversible.");
    }

    targetUser.role = "CREATOR";
    await targetUser.save();

    // Invalidate all sessions so the promoted user must log in again to receive the new role
    await invalidateUserSessions(userId);
    await invalidateUserProfileCache(userId);

    return successResponse(res, 200, "User promoted to CREATOR successfully", {
      userId,
      role: "CREATOR",
    });
  } catch (err) {
    console.error("[promoteToCreator] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to promote user");
  }
};
