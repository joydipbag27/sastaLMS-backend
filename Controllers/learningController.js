import mongoose from "mongoose";
import Course from "../Models/courseModel.js";
import Section from "../Models/sectionModel.js";
import Lesson from "../Models/lessonModel.js";
import Enrollment from "../Models/enrollmentModel.js";
import LessonProgress from "../Models/lessonProgressModel.js";
import { successResponse, errorResponse } from "../utils/response.js";

// Regex matching the project's existing ObjectId validation convention
const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

/**
 * Shared course-access resolver for Learning endpoints.
 *
 * Fetches minimal course data, determines privileged access (admin/creator),
 * and — for non-privileged users — enforces Published status and Active
 * enrollment.  Returns a result object on success or an error response on
 * failure (early return pattern used throughout the existing codebase).
 *
 * @param {string} courseId  - Validated 24-char hex string
 * @param {object} reqUser   - req.user populated by authenticate middleware
 * @param {object} res       - Express response object (used for early error returns)
 * @param {object} [courseSelectFields]  - Optional .select() override
 * @returns {Promise<{ course, userId, isCreator, hasPrivilegedAccess, enrollment } | null>}
 *   Returns null when an error response was already sent.
 */
const resolveCourseAccess = async (
  courseId,
  reqUser,
  res,
  courseSelectFields = "_id creator status stats"
) => {
  const course = await Course.findById(courseId)
    .select(courseSelectFields)
    .lean();

  if (!course) {
    errorResponse(res, 404, "Course not found");
    return null;
  }

  const userId = reqUser._id;
  // creator._id when populated, plain ObjectId otherwise
  const creatorId = course.creator?._id ?? course.creator;
  const isCreator = creatorId && creatorId.toString() === userId.toString();
  const hasPrivilegedAccess = isCreator;

  let enrollment = null;

  if (!hasPrivilegedAccess) {
    if (course.status !== "Published") {
      errorResponse(res, 403, "This course is not published");
      return null;
    }

    enrollment = await Enrollment.findOne({
      user: userId,
      course: courseId,
      status: "Active",
    })
      .select("_id status enrolledAt")
      .lean();

    if (!enrollment) {
      errorResponse(res, 403, "You are not enrolled in this course");
      return null;
    }
  }

  return { course, userId, isCreator, hasPrivilegedAccess, enrollment };
};

/**
 * Calculate aggregated course-level progress for a specific user.
 *
 * Uses a MongoDB aggregation so that summarising thousands of records
 * never loads them all into application memory.
 *
 * Extracted as a named function so it can be reused by future
 * GET /learning/me and GET /learning/courses/:courseId/progress endpoints.
 *
 * @param {string|mongoose.Types.ObjectId} userId
 * @param {string|mongoose.Types.ObjectId} courseId
 * @returns {Promise<{ completedLessons: number, totalWatchTime: number }>}
 */
export const aggregateCourseProgress = async (userId, courseId) => {
  const [result] = await LessonProgress.aggregate([
    {
      $match: {
        user: new mongoose.Types.ObjectId(userId),
        course: new mongoose.Types.ObjectId(courseId),
      },
    },
    {
      $group: {
        _id: null,
        completedLessons: {
          $sum: { $cond: [{ $eq: ["$completed", true] }, 1, 0] },
        },
        totalWatchTime: { $sum: "$duration" },
      },
    },
  ]);

  return {
    completedLessons: result?.completedLessons ?? 0,
    totalWatchTime: result?.totalWatchTime ?? 0,
  };
};

/**
 * GET /learning/courses/:courseId/sections/:sectionId
 *
 * Returns all data required when a student (or creator/admin) loads a
 * section inside the Classroom:
 *   - course summary
 *   - access flags
 *   - active enrollment (if any)
 *   - course-level progress summary
 *   - section metadata with its lessons
 *   - per-lesson progress merged inline
 *
 * Access rules:
 *   - CREATOR     — full access to own course, any status, no enrollment required
 *   - STUDENT     — course must be Published + user must have an Active enrollment
 *
 * Preview lessons do NOT grant access to this endpoint.
 */
export const getLearningSectionData = async (req, res) => {
  try {
    const { courseId, sectionId } = req.params;

    // ── 1. Validate param format ─────────────────────────────────────────────
    if (!OBJECT_ID_REGEX.test(courseId)) {
      return errorResponse(res, 400, "Invalid course ID");
    }
    if (!OBJECT_ID_REGEX.test(sectionId)) {
      return errorResponse(res, 400, "Invalid section ID");
    }

    // ── 2. Resolve course access (fetches course + enforces enrollment) ───────
    // The section endpoint needs populated creator + thumbnail for its response,
    // so we bypass resolveCourseAccess and do a richer fetch here.
    const course = await Course.findById(courseId)
      .select("_id title displayName creator thumbnail status stats")
      .populate("creator", "username email")
      .populate("thumbnail", "_id status mimeType")
      .lean();

    if (!course) {
      return errorResponse(res, 404, "Course not found");
    }

    const userId = req.user._id;
    const isCreator =
      course.creator && course.creator._id.toString() === userId.toString();
    const hasPrivilegedAccess = isCreator;

    let enrollment = null;

    if (!hasPrivilegedAccess) {
      if (course.status !== "Published") {
        return errorResponse(res, 403, "This course is not published");
      }

      enrollment = await Enrollment.findOne({
        user: userId,
        course: courseId,
        status: "Active",
      })
        .select("_id status enrolledAt")
        .lean();

      if (!enrollment) {
        return errorResponse(res, 403, "You are not enrolled in this course");
      }
    }

    // ── 3. Fetch section — verify it belongs to the requested course ─────────
    const section = await Section.findOne({
      _id: sectionId,
      course: courseId,
    })
      .select("_id title description order")
      .lean();

    if (!section) {
      return errorResponse(res, 404, "Section not found");
    }

    // ── 4. Fetch lessons for this section, sorted by order ascending ─────────
    const lessons = await Lesson.find({ course: courseId, section: sectionId })
      .sort({ order: 1 })
      .select("_id title description duration isPreview order video")
      .populate("video", "_id status duration")
      .lean();

    // ── 5. Fetch section lesson progress in one query (avoids N+1) ───────────
    const lessonIds = lessons.map((l) => l._id);

    let progressByLessonId = {};

    if (lessonIds.length > 0) {
      const progressRecords = await LessonProgress.find({
        user: userId,
        course: courseId,
        lesson: { $in: lessonIds },
      })
        .select(
          "lesson completed completedAt lastPosition maxPositionReached duration"
        )
        .lean();

      for (const record of progressRecords) {
        progressByLessonId[record.lesson.toString()] = record;
      }
    }

    // ── 6. Merge progress into each lesson ───────────────────────────────────
    const DEFAULT_PROGRESS = {
      completed: false,
      completedAt: null,
      lastPosition: 0,
      maxPositionReached: 0,
      watchDuration: 0,
    };

    const lessonsWithProgress = lessons.map((lesson) => {
      const record = progressByLessonId[lesson._id.toString()];
      const progress = record
        ? {
            completed: record.completed,
            completedAt: record.completedAt,
            lastPosition: record.lastPosition,
            maxPositionReached: record.maxPositionReached,
            watchDuration: record.duration,
          }
        : DEFAULT_PROGRESS;

      return { ...lesson, progress };
    });

    // ── 7. Calculate course-level progress summary ───────────────────────────
    //
    // stats.lessonCount is atomically maintained (incremented on lesson create,
    // decremented on lesson/section/course delete) — reliable to use here.
    const totalLessons = course.stats?.lessonCount ?? 0;

    // Creators may have no student progress records.
    // The aggregation returns safe zero defaults for them.
    const progressSummary = await aggregateCourseProgress(userId, courseId);
    const completedLessons = progressSummary.completedLessons;
    const totalWatchTime = progressSummary.totalWatchTime;

    const progressPercentage =
      totalLessons > 0
        ? Math.min(100, Math.round((completedLessons / totalLessons) * 100))
        : 0;

    const courseProgress = {
      totalLessons,
      completedLessons,
      progressPercentage,
      totalWatchTime,
    };

    // ── 8. Build and return response ─────────────────────────────────────────
    const isEnrolled = !!enrollment;
    const canLearn = hasPrivilegedAccess || isEnrolled;

    return successResponse(res, 200, "Section data fetched", {
      course: {
        _id: course._id,
        title: course.title,
        displayName: course.displayName,
        creator: course.creator,
        thumbnail: course.thumbnail,
        status: course.status,
        stats: course.stats,
      },

      access: {
        isCreator,
        isEnrolled,
        canLearn,
      },

      enrollment: enrollment
        ? {
            _id: enrollment._id,
            status: enrollment.status,
            enrolledAt: enrollment.enrolledAt,
          }
        : null,

      courseProgress,

      section: {
        _id: section._id,
        title: section.title,
        description: section.description,
        order: section.order,
        lessons: lessonsWithProgress,
      },
    });
  } catch (err) {
    console.error("[getLearningSectionData] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch section data");
  }
};

/**
 * GET /learning/courses/:courseId/progress
 *
 * Returns a minimal, authoritative course completion summary for the
 * current authenticated user.
 *
 * Always scoped to req.user._id — never accepts a userId from the client.
 *
 * Access rules (identical to the Learning Section endpoint):
 *   - CREATOR     — own course, any status, no enrollment required → zeros
 *   - STUDENT     — course must be Published + Active enrollment required
 */
export const getCourseProgress = async (req, res) => {
  try {
    const { courseId } = req.params;

    // ── 1. Validate param format ─────────────────────────────────────────────
    if (!OBJECT_ID_REGEX.test(courseId)) {
      return errorResponse(res, 400, "Invalid course ID");
    }

    // ── 2. Resolve course access ─────────────────────────────────────────────
    // Fetches minimal course fields; enforces Published status and Active
    // enrollment for non-privileged users.  Returns null when an error
    // response has already been sent.
    const access = await resolveCourseAccess(courseId, req.user, res);
    if (!access) return; // resolveCourseAccess already sent the error response

    const { course, userId, hasPrivilegedAccess } = access;

    // ── 3. Resolve totalLessons from the authoritative counter ───────────────
    //
    // stats.lessonCount is maintained atomically by every lesson/section/course
    // create and delete path — it is safe to rely on directly.
    const totalLessons = course.stats?.lessonCount ?? 0;

    // ── 4. Privileged users: return stable zero progress ─────────────────────
    //
    // Creators are not expected to have enrollment-backed progress
    // records.  Return the authoritative total so the UI can render
    // "0 / N completed" without a separate course-fetch.
    if (hasPrivilegedAccess) {
      return successResponse(res, 200, "Course progress fetched", {
        courseId,
        totalLessons,
        completedLessons: 0,
        progressPercentage: 0,
      });
    }

    // ── 5. Count completed lessons for the enrolled student ──────────────────
    //
    // countDocuments is cheaper than aggregate for a simple boolean filter.
    // Uses the existing compound index { user: 1, course: 1 } — no new index
    // is required at current project scale.
    const completedLessons = await LessonProgress.countDocuments({
      user: userId,
      course: courseId,
      completed: true,
    });

    // ── 6. Calculate percentage (guarded against stale/corrupt data) ─────────
    const progressPercentage =
      totalLessons > 0
        ? Math.min(100, Math.round((completedLessons / totalLessons) * 100))
        : 0;

    // ── 7. Return minimal response ───────────────────────────────────────────
    return successResponse(res, 200, "Course progress fetched", {
      courseId,
      totalLessons,
      completedLessons,
      progressPercentage,
    });
  } catch (err) {
    console.error("[getCourseProgress] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch course progress");
  }
};
