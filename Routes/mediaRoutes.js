import express from "express";
import {
  getLessonVideoUploadUrl,
  getLessonVideoReplaceUrl,
  confirmLessonVideoUpload,
  getLessonVideoUploadUrlS3,
  getLessonVideoReplaceUrlS3,
  confirmLessonVideoUploadS3,
  getMediaDownloadUrl,
  deleteMedia,
  mediaProcessCompleted
} from "../Controllers/mediaController.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { roles } from "../config/roles.js";
import { customRateLimit } from "../middlewares/rateLimit.js";


const router = express.Router();

router.post("/internal/processing-complete", mediaProcessCompleted)


router.post(
  "/lesson/:lessonId/upload-url",
  customRateLimit(1, 15),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  getLessonVideoUploadUrl,
);

router.post(
  "/lesson/:lessonId/replace-url",
  customRateLimit(1, 15),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  getLessonVideoReplaceUrl,
);

router.post(
  "/lesson/:lessonId/confirm",
  customRateLimit(1, 15),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  confirmLessonVideoUpload,
);

// S3 video upload routes
router.post(
  "/s3/lesson/:lessonId/upload-url",
  customRateLimit(1, 15),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  getLessonVideoUploadUrlS3,
);

router.post(
  "/s3/lesson/:lessonId/replace-url",
  customRateLimit(1, 15),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  getLessonVideoReplaceUrlS3,
);

router.post(
  "/s3/lesson/:lessonId/confirm",
  customRateLimit(1, 15),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  confirmLessonVideoUploadS3,
);

router.get(
  "/:id/download",
  customRateLimit(1, 30),
  authenticate,
  getMediaDownloadUrl,
);

router.delete(
  "/:id",
  customRateLimit(1, 10),
  authenticate,
  deleteMedia,
);


export default router;
