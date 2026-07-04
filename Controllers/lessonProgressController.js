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
        duration: lesson.duration || 0,
        lastPosition,
        maxPositionReached: lastPosition,
      });
    } else {
      // Update playback state
      progress.lastPosition = lastPosition;
      progress.maxPositionReached = Math.max(progress.maxPositionReached, lastPosition);
    }

    // Always update lastWatchedAt
    progress.lastWatchedAt = new Date();

    // Temporary completion logic: maxPositionReached >= 95% of duration
    if (!progress.completed && progress.duration > 0) {
      if (progress.maxPositionReached / progress.duration >= 0.95) {
        progress.completed = true;
        progress.completedAt = new Date();
      }
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
