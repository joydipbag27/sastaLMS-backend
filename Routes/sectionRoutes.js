import express from "express";
import {
  createSection,
  getSectionsByCourse,
  getMySectionsByCourse,
  getSectionById,
  getMySectionById,
  updateSection,
  deleteSection,
} from "../Controllers/sectionController.js";
import { authenticate } from "../middlewares/authenticate.js";
import { optionalAuthenticate } from "../middlewares/optionalAuthenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { roles } from "../config/roles.js";
import { customRateLimit } from "../middlewares/rateLimit.js";

const router = express.Router();

router.post(
  "/",
  customRateLimit(1, 10),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  createSection,
);

router.get("/course/:courseId", optionalAuthenticate, getSectionsByCourse);

router.get(
  "/creator/course/:courseId",
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  getMySectionsByCourse,
);

router.get(
  "/creator/:id",
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  getMySectionById,
);

router.get("/:id", optionalAuthenticate, getSectionById);

router.patch(
  "/:id",
  customRateLimit(1, 10),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  updateSection,
);

router.delete(
  "/:id",
  customRateLimit(1, 10),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  deleteSection,
);

export default router;
