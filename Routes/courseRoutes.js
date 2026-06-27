import express from "express";
import {
  createCourse,
  getCourses,
  getMyCourses,
  getCourseById,
  updateCourse,
  publishCourse,
  unpublishCourse,
  deleteCourse,
  getCourseDetails,
  getThumbnailUploadUrl,
  confirmThumbnail,
  deleteThumbnail,
} from "../Controllers/courseController.js";
import { enrollInCourse, getMyEnrollments, getEnrollmentByCourseId } from "../Controllers/enrollmentController.js";
import { authenticate } from "../middlewares/authenticate.js";
import { optionalAuthenticate } from "../middlewares/optionalAuthenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { roles } from "../config/roles.js";
import { customRateLimit } from "../middlewares/rateLimit.js";

const router = express.Router();

router.post(
  "/",
  customRateLimit(1, 5),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  createCourse,
);

router.get("/", getCourses);

router.get(
  "/creator/me",
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  getMyCourses,
);



router.get(
  "/enrollments/me",
  authenticate,
  getMyEnrollments,
);

router.get("/:id", getCourseById);

router.get("/:id/details", optionalAuthenticate, getCourseDetails);

router.get(
  "/:id/enrollment",
  authenticate,
  getEnrollmentByCourseId,
);

router.post(
  "/:id/thumbnail/upload-url",
  customRateLimit(1, 10),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  getThumbnailUploadUrl,
);

router.post(
  "/:id/thumbnail/confirm",
  customRateLimit(1, 10),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  confirmThumbnail,
);

router.delete(
  "/:id/thumbnail",
  customRateLimit(1, 10),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  deleteThumbnail,
);

router.post(
  "/:id/enroll",
  customRateLimit(1, 10),
  authenticate,
  enrollInCourse,
);

router.patch(
  "/:id/publish",
  customRateLimit(1, 10),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  publishCourse,
);

router.patch(
  "/:id/unpublish",
  customRateLimit(1, 10),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  unpublishCourse,
);

router.patch(
  "/:id",
  customRateLimit(1, 10),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  updateCourse,
);

router.delete(
  "/:id",
  customRateLimit(1, 5),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  deleteCourse,
);

export default router;
