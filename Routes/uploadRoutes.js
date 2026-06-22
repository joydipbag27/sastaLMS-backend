import express from "express";
import {
  getUploadUrl,
  getDownloadUrl,
} from "../Controllers/uploadController.js";
import { checkAuth, checkIfBlocked } from "../middlewares/authMiddleware.js";
import { customRateLimit } from "../middlewares/rateLimit.js";

const router = express.Router();

router.post(
  "/upload-url",
  customRateLimit(1, 15),
  checkAuth,
  checkIfBlocked,
  getUploadUrl,
);
router.get(
  "/download-url/:key",
  customRateLimit(1, 30),
  checkAuth,
  checkIfBlocked,
  getDownloadUrl,
);

export default router;
