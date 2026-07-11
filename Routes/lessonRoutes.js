import express from "express";
import {
  createLesson,
  getLessonsBySection,
  getMyLessonsBySection,
  getLessonById,
  getMyLessonById,
  updateLesson,
  deleteLesson,
} from "../Controllers/lessonController.js";
import { getLessonPlaybackUrl } from "../Controllers/mediaController.js";
import { getLessonProgress, updateLessonProgress } from "../Controllers/lessonProgressController.js";
import { authenticate } from "../middlewares/authenticate.js";
import { optionalAuthenticate } from "../middlewares/optionalAuthenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { checkLessonAccess } from "../middlewares/lessonAccess.js";
import { roles } from "../config/roles.js";
import { customRateLimit } from "../middlewares/rateLimit.js";

const router = express.Router();

router.post(
  "/",
  customRateLimit(1, 10),
  authenticate,
  authorize(roles.CREATOR),
  createLesson,
);

router.get("/section/:sectionId", optionalAuthenticate, getLessonsBySection);

router.get(
  "/creator/section/:sectionId",
  authenticate,
  authorize(roles.CREATOR),
  getMyLessonsBySection,
);

router.get(
  "/creator/:id",
  authenticate,
  authorize(roles.CREATOR),
  getMyLessonById,
);

router.get(
  "/:id/play",
  customRateLimit(1, 30),
  authenticate,
  checkLessonAccess,
  getLessonPlaybackUrl,
);

router.get("/:id/progress", authenticate, checkLessonAccess, getLessonProgress);
router.patch("/:id/progress", authenticate, checkLessonAccess, updateLessonProgress);

router.get("/:id", customRateLimit(1, 60), authenticate, checkLessonAccess, getLessonById);

router.patch(
  "/:id",
  customRateLimit(1, 10),
  authenticate,
  authorize(roles.CREATOR),
  updateLesson,
);

router.delete(
  "/:id",
  customRateLimit(1, 10),
  authenticate,
  authorize(roles.CREATOR),
  deleteLesson,
);

export default router;
