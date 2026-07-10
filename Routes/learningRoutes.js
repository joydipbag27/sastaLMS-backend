import express from "express";
import { getLearningSectionData, getCourseProgress } from "../Controllers/learningController.js";
import { authenticate } from "../middlewares/authenticate.js";

const router = express.Router();

// GET /learning/courses/:courseId/progress
// Returns a minimal course completion summary for the current user.
// Registered before the sections route to keep specific patterns first.
router.get(
  "/courses/:courseId/progress",
  authenticate,
  getCourseProgress,
);

// GET /learning/courses/:courseId/sections/:sectionId
// Returns all Classroom data for a section: course summary, access flags,
// enrollment, course-level progress, section + lessons with inline progress.
router.get(
  "/courses/:courseId/sections/:sectionId",
  authenticate,
  getLearningSectionData,
);

export default router;
