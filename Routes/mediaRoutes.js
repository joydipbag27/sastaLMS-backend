import express from "express";
import {
  getMediaUploadUrl,
  confirmMediaUpload,
  getMediaDownloadUrl,
  deleteMedia,
} from "../Controllers/mediaController.js";
import { authenticate } from "../middlewares/authenticate.js";
import { customRateLimit } from "../middlewares/rateLimit.js";

const router = express.Router();

router.post(
  "/upload-url",
  customRateLimit(1, 15),
  authenticate,
  getMediaUploadUrl,
);

router.post(
  "/confirm-upload",
  customRateLimit(1, 15),
  authenticate,
  confirmMediaUpload,
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
