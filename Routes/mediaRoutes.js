import express from "express";
import {
  getLessonVideoUploadUrlS3,
  confirmLessonVideoUploadS3,
  mediaProcessCompleted,
  retryMediaTransfer,
} from "../Controllers/mediaController.js";
import {
  createManualMedia,
  verifyManualMedia,
} from "../Controllers/manualMediaController.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { roles } from "../config/roles.js";
import { customRateLimit } from "../middlewares/rateLimit.js";


const router = express.Router();

router.post("/internal/processing-complete", mediaProcessCompleted)


// S3 video upload routes
router.post(
  "/s3/lesson/:lessonId/upload-url",
  customRateLimit(1, 15),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  getLessonVideoUploadUrlS3,
);

router.post(
  "/s3/lesson/:lessonId/confirm",
  customRateLimit(1, 15),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  confirmLessonVideoUploadS3,
);

// Manual video upload/ingestion routes
router.post(
  "/manual",
  customRateLimit(1, 15),
  authenticate,
  authorize(roles.CREATOR, roles.ADMIN),
  createManualMedia,
);

router.post(
  "/manual/:mediaId/verify",
  customRateLimit(1, 15),
  authenticate,
  verifyManualMedia,
);

// Admin-only: retry a COPY_PENDING media's failed file transfers
router.post(
  "/:id/retry-transfer",
  customRateLimit(1, 5),
  authenticate,
  authorize(roles.ADMIN),
  retryMediaTransfer,
);

export default router;
