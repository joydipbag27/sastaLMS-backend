import mongoose from "mongoose";
import Course from "../Models/courseModel.js";
import Section from "../Models/sectionModel.js";
import Lesson from "../Models/lessonModel.js";

/**
 * Recalculates the denormalized stats.sectionCount and stats.lessonCount
 * for a single course by querying the source-of-truth collections.
 *
 * This function must NOT be called during normal public request flows.
 * It is intended for:
 *   - one-time backfill migrations
 *   - debugging and admin repair
 *   - periodic reconciliation jobs
 *   - tests
 *
 * @param {string|mongoose.Types.ObjectId} courseId
 * @returns {Promise<{ sectionCount: number, lessonCount: number }>}
 */
export async function recalculateCourseStats(courseId) {
  if (!mongoose.isValidObjectId(courseId)) {
    throw new Error(`[recalculateCourseStats] Invalid courseId: ${courseId}`);
  }

  // Run both counts concurrently — they are independent queries
  const [sectionCount, lessonCount] = await Promise.all([
    Section.countDocuments({ course: courseId }),
    Lesson.countDocuments({ course: courseId }),
  ]);

  await Course.updateOne(
    { _id: courseId },
    {
      $set: {
        "stats.sectionCount": sectionCount,
        "stats.lessonCount": lessonCount,
      },
    }
  );

  return { sectionCount, lessonCount };
}
