/**
 * backfillCourseStats.js
 *
 * One-time backfill script that populates stats.sectionCount and
 * stats.lessonCount on every existing Course document.
 *
 * Safe to run multiple times — uses $set so re-running produces
 * the same correct result.
 *
 * Iterates via a cursor so it never loads all courses into memory at once.
 *
 * Usage:
 *   node --env-file=.env scripts/backfillCourseStats.js
 */

import "dotenv/config";
import mongoose from "mongoose";
import Course from "../Models/courseModel.js";
import Section from "../Models/sectionModel.js";
import Lesson from "../Models/lessonModel.js";

async function backfill() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("[backfill] Connected to MongoDB");

  let processed = 0;
  let errors = 0;

  // Use a lean cursor to avoid loading all Course documents into memory
  const cursor = Course.find({}).select("_id").lean().cursor();

  for await (const course of cursor) {
    try {
      const courseId = course._id;

      // Count sections and lessons concurrently for each course
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

      processed++;
      console.log(
        `[backfill] Course ${courseId}: sectionCount=${sectionCount}, lessonCount=${lessonCount}`
      );
    } catch (err) {
      errors++;
      console.error(`[backfill] Error processing course ${course._id}:`, err);
    }
  }

  console.log(
    `[backfill] Done. Processed: ${processed}, Errors: ${errors}`
  );
  await mongoose.disconnect();
  process.exit(errors > 0 ? 1 : 0);
}

backfill().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
