import LessonProgress from "../Models/lessonProgressModel.js";
import Enrollment from "../Models/enrollmentModel.js";
import { successResponse, errorResponse } from "../utils/response.js";
import { updateLessonProgressSchema } from "../validators/lessonProgressSchema.js";

// GET LESSON PROGRESS
export const getLessonProgress = async (req, res) => {
  try {
    // req.lesson is pre-fetched and access-validated by checkLessonAccess middleware
    const lesson = req.lesson;

    const progress = await LessonProgress.findOne({
      user: req.user._id,
      lesson: lesson._id,
    }).lean();

    if (progress) {
      return successResponse(res, 200, "Lesson progress fetched", {
        progress: {
          lastPosition: progress.lastPosition,
          maxPositionReached: progress.maxPositionReached,
          duration: progress.duration,
          completed: progress.completed,
          completedAt: progress.completedAt,
          lastWatchedAt: progress.lastWatchedAt,
        },
      });
    }

    // No progress exists — return defaults without creating a document
    return successResponse(res, 200, "Lesson progress fetched", {
      progress: {
        lastPosition: 0,
        maxPositionReached: 0,
        duration: lesson.duration || 0,
        completed: false,
        completedAt: null,
        lastWatchedAt: null,
      },
    });
  } catch (err) {
    console.error("[getLessonProgress] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch lesson progress");
  }
};

// PATCH LESSON PROGRESS
export const updateLessonProgress = async (req, res) => {
  const { success, data, error } = updateLessonProgressSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  try {
    const lesson = req.lesson;
    const userId = req.user._id;
    const { lastPosition } = data;

    // Position safety check for non-finite values
    if (!Number.isFinite(lastPosition)) {
      return errorResponse(res, 400, "lastPosition must be a finite number");
    }

    const authoritativeDuration = lesson.duration || 0;
    const safeLastPosition =
      authoritativeDuration > 0
        ? Math.min(lastPosition, authoritativeDuration)
        : lastPosition;

    let progress = await LessonProgress.findOne({ user: userId, lesson: lesson._id });

    if (!progress) {
      // Find the active enrollment for this user + course
      const enrollment = await Enrollment.findOne({
        user: userId,
        course: lesson.course,
        status: "Active",
      });

      if (!enrollment) {
        return errorResponse(res, 403, "Active enrollment not found");
      }

      progress = new LessonProgress({
        user: userId,
        enrollment: enrollment._id,
        course: lesson.course,
        section: lesson.section,
        lesson: lesson._id,
        duration: authoritativeDuration,
        lastPosition: safeLastPosition,
        maxPositionReached: safeLastPosition,
      });
    } else {
      // Synchronize progress duration with authoritative lesson duration if they differ
      if (authoritativeDuration > 0 && progress.duration !== authoritativeDuration) {
        progress.duration = authoritativeDuration;
      }

      // Update playback state safely
      progress.lastPosition = safeLastPosition;
      progress.maxPositionReached = Math.max(progress.maxPositionReached, safeLastPosition);
    }

    // Always update lastWatchedAt
    progress.lastWatchedAt = new Date();

    // Authoritative completion logic
    const COMPLETION_THRESHOLD = 0.90;
    const endTolerance = Math.min(
      5,
      Math.max(1, progress.duration * 0.02)
    );

    const reachedThreshold =
      progress.maxPositionReached >= progress.duration * COMPLETION_THRESHOLD;

    const reachedNearEnd =
      progress.duration - progress.maxPositionReached <= endTolerance;

    if (!progress.completed && progress.duration > 0 && (reachedThreshold || reachedNearEnd)) {
      progress.completed = true;
      progress.completedAt = new Date();
    }

    await progress.save();

    return successResponse(res, 200, "Lesson progress updated", {
      progress: {
        lastPosition: progress.lastPosition,
        maxPositionReached: progress.maxPositionReached,
        duration: progress.duration,
        completed: progress.completed,
        completedAt: progress.completedAt,
        lastWatchedAt: progress.lastWatchedAt,
      },
    });
  } catch (err) {
    console.error("[updateLessonProgress] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to update lesson progress");
  }
};
