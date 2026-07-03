import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  s3Client,
  permanentlyDeleteMultipleFromB2,
} from "../config/s3Client.js";
import {
  awsS3Client,
  generateVideoUploadUrlS3,
  deleteVideoFromS3,
  getVideoMetadataFromS3,
} from "../config/awsS3Client.js";
import Media from "../Models/mediaModel.js";
import Course from "../Models/courseModel.js";
import Lesson from "../Models/lessonModel.js";
import {
  confirmUploadSchema,
  uploadUrlSchema,
  mediaProcessingCompleteSchema,
} from "../validators/mediaSchema.js";
import { successResponse, errorResponse } from "../utils/response.js";
import { createJob } from "../services/mediaConvertService.js";
import {
  deleteConfirmedS3Objects,
  deleteS3InputVideo,
} from "../services/b2Service.js";
import {
  transferHlsToB2,
  retryFailedTransfers,
} from "../services/rcloneTransferService.js";
import { generatePlaybackToken } from "../services/playbackTokenService.js";

// POST /media/s3/lesson/:lessonId/upload-url
export const getLessonVideoUploadUrlS3 = async (req, res) => {
  const { lessonId } = req.params;
  const { success, data, error } = uploadUrlSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  try {
    const lesson = await Lesson.findById(lessonId);
    if (!lesson) return errorResponse(res, 404, "Lesson not found");

    if (lesson.video) {
      return errorResponse(res, 400, "Lesson already has a video attached");
    }

    const course = await Course.findById(lesson.course);
    if (!course) return errorResponse(res, 404, "Associated course not found");

    if (
      req.user.role !== "ADMIN" &&
      course.creator.toString() !== req.user._id.toString()
    ) {
      return errorResponse(
        res,
        403,
        "You do not have permission to modify this lesson",
      );
    }

    // Create a draft Media document — its _id becomes the S3 key
    const media = await Media.create({
      uploadedBy: req.user._id,
      mimeType: data.mimeType,
      size: 0,
      status: "UPLOADING",
      type: "VIDEO",
      storageProvider: "AWS_S3",
    });

    const key = media._id.toString();

    // Generate AWS S3 presigned PUT URL
    const { uploadUrl } = await generateVideoUploadUrlS3(key, data.mimeType);

    return successResponse(res, 200, "Upload URL generated", {
      uploadUrl,
      mediaId: key,
    });
  } catch (err) {
    console.error(
      "[getLessonVideoUploadUrlS3] Failed to generate presigned PUT URL:",
      err,
    );
    return errorResponse(res, 500, "Failed to generate upload URL");
  }
};

// POST /media/s3/lesson/:lessonId/replace-url
export const getLessonVideoReplaceUrlS3 = async (req, res) => {
  const { lessonId } = req.params;
  const { success, data, error } = uploadUrlSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  try {
    const lesson = await Lesson.findById(lessonId);
    if (!lesson) return errorResponse(res, 404, "Lesson not found");

    if (!lesson.video) {
      return errorResponse(
        res,
        400,
        "Lesson does not have a video to replace. Use the upload endpoint instead.",
      );
    }

    const oldMediaId = lesson.video;
    const oldMedia = await Media.findById(oldMediaId);
    if (oldMedia) {
      if (oldMedia.storageProvider === "AWS_S3") {
        await deleteVideoFromS3(oldMediaId.toString());
      } else {
        await permanentlyDeleteMultipleFromB2([oldMediaId.toString()]);
      }
      await oldMedia.deleteOne();
    }
    lesson.video = null;
    await lesson.save();

    const course = await Course.findById(lesson.course);
    if (!course) return errorResponse(res, 404, "Associated course not found");

    if (
      req.user.role !== "ADMIN" &&
      course.creator.toString() !== req.user._id.toString()
    ) {
      return errorResponse(
        res,
        403,
        "You do not have permission to modify this lesson",
      );
    }

    // Create a draft Media document — its _id becomes the S3 key
    const media = await Media.create({
      uploadedBy: req.user._id,
      mimeType: data.mimeType,
      size: 0,
      status: "UPLOADING",
      type: "VIDEO",
      storageProvider: "AWS_S3",
    });

    const key = media._id.toString();

    // Generate AWS S3 presigned PUT URL
    const { uploadUrl } = await generateVideoUploadUrlS3(key, data.mimeType);

    return successResponse(res, 200, "Replace URL generated", {
      uploadUrl,
      mediaId: key,
    });
  } catch (err) {
    console.error(
      "[getLessonVideoReplaceUrlS3] Failed to generate presigned PUT URL:",
      err,
    );
    return errorResponse(res, 500, "Failed to generate replace URL");
  }
};

// POST /media/s3/lesson/:lessonId/confirm
export const confirmLessonVideoUploadS3 = async (req, res) => {
  const { lessonId } = req.params;
  const { success, data, error } = confirmUploadSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  try {
    const lesson = await Lesson.findById(lessonId);
    if (!lesson) return errorResponse(res, 404, "Lesson not found");

    const course = await Course.findById(lesson.course);
    if (!course) return errorResponse(res, 404, "Associated course not found");

    if (
      req.user.role !== "ADMIN" &&
      course.creator.toString() !== req.user._id.toString()
    ) {
      return errorResponse(
        res,
        403,
        "You do not have permission to modify this lesson",
      );
    }

    const media = await Media.findById(data.mediaId);
    if (!media) return errorResponse(res, 404, "Media record not found");

    const key = media._id.toString();

    // Verify file exists on S3 and size matches
    let s3Data;
    try {
      s3Data = await getVideoMetadataFromS3(key);
    } catch (err) {
      console.error(
        "[confirmLessonVideoUploadS3] File lookup failed on S3. Cleaning up:",
        err,
      );
      await deleteVideoFromS3(key);
      await media.deleteOne();
      return errorResponse(res, 400, "File does not exist on storage");
    }

    if (s3Data.contentLength !== data.size) {
      console.error(
        `[confirmLessonVideoUploadS3] File size mismatch: expected ${data.size}, got ${s3Data.contentLength}`,
      );
      await deleteVideoFromS3(key);
      await media.deleteOne();
      return errorResponse(res, 400, "File size mismatch on storage");
    }

    media.mimeType = data.mimeType;
    media.size = data.size;
    media.status = "PROCESSING";
    await media.save();

    // Associate media with lesson and clean up old media if exists
    const oldMediaId = lesson.video;
    lesson.video = media._id;
    await lesson.save();

    if (oldMediaId && oldMediaId.toString() !== media._id.toString()) {
      const oldMedia = await Media.findById(oldMediaId);
      if (oldMedia) {
        if (oldMedia.storageProvider === "AWS_S3") {
          await deleteVideoFromS3(oldMediaId.toString());
        } else {
          await permanentlyDeleteMultipleFromB2([oldMediaId.toString()]);
        }
        await oldMedia.deleteOne();
      }
    }

    const updatedLesson = await Lesson.findById(lessonId).populate("video");

    await createJob({ mediaId: key });

    return successResponse(
      res,
      200,
      "Lesson video upload confirmed and associated successfully",
      { lesson: updatedLesson, media },
    );
  } catch (err) {
    console.error("[confirmLessonVideoUploadS3] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to confirm upload");
  }
};

// GET /lesson/:lessonId/play
export const getLessonPlaybackUrl = async (req, res) => {
  try {
    // req.lesson is pre-fetched and access-validated by checkLessonAccess middleware
    const lesson = req.lesson;

    if (!lesson.video) {
      return errorResponse(res, 404, "This lesson does not have a video attached");
    }

    const media = lesson.video;

    if (media.status !== "READY") {
      return errorResponse(
        res,
        423,
        "Video is still processing. Please try again shortly.",
      );
    }

    const mediaId = media._id.toString();
    const courseId = lesson.course.toString();
    const userId = req.user._id.toString();

    const token = generatePlaybackToken({ userId, mediaId, courseId });

    const workerBase = process.env.CLOUDFLARE_WORKER_URL?.replace(/\/$/, "");
    if (!workerBase) {
      console.error("[getLessonPlaybackUrl] CLOUDFLARE_WORKER_URL is not configured.");
      return errorResponse(res, 500, "Playback service is not configured");
    }

    const playlistUrl = `${workerBase}/videos/${mediaId}/${mediaId}.m3u8?token=${token}`;

    return successResponse(res, 200, "Playback URL generated", { playlistUrl });
  } catch (err) {
    console.error("[getLessonPlaybackUrl] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to generate playback URL");
  }
};

// GET /media/:id/download
export const getMediaDownloadUrl = async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f\d]{24}$/i.test(id))
    return errorResponse(res, 400, "Invalid media ID");

  try {
    const media = await Media.findById(id);
    if (!media) return errorResponse(res, 404, "Media not found");

    let downloadUrl;
    if (media.storageProvider === "AWS_S3") {
      const command = new GetObjectCommand({
        Bucket: process.env.MEDIACONVERT_INPUT_BUCKET,
        Key: media._id.toString(),
      });
      downloadUrl = await getSignedUrl(awsS3Client, command, {
        expiresIn: 3600,
      });
    } else {
      const command = new GetObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: media._id.toString(),
      });
      downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    }

    return successResponse(res, 200, "Download URL generated", { downloadUrl });
  } catch (err) {
    console.error(
      "[getMediaDownloadUrl] Failed to generate presigned GET URL:",
      err,
    );
    return errorResponse(res, 500, "Failed to generate download URL");
  }
};

// DELETE /media/:id
export const deleteMedia = async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f\d]{24}$/i.test(id))
    return errorResponse(res, 400, "Invalid media ID");

  try {
    const media = await Media.findById(id);
    if (!media) return errorResponse(res, 404, "Media not found");

    // Only uploader or ADMIN may delete
    if (
      req.user.role !== "ADMIN" &&
      media.uploadedBy.toString() !== req.user._id.toString()
    ) {
      return errorResponse(
        res,
        403,
        "You do not have permission to delete this media",
      );
    }

    if (media.storageProvider === "AWS_S3") {
      await deleteVideoFromS3(media._id.toString());
    } else {
      await permanentlyDeleteMultipleFromB2([media._id.toString()]);
    }
    await media.deleteOne();

    return successResponse(res, 200, "Media deleted successfully");
  } catch (err) {
    console.error("[deleteMedia] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to delete media");
  }
};

// Media process-complete by lambda
export const mediaProcessCompleted = async (req, res) => {
  const lambdaSecret = req.header("x-veolms-secret");

  if (!lambdaSecret || lambdaSecret !== process.env.LAMBDA_SECRET) {
    return errorResponse(res, 401, "Unauthorized");
  }

  const { success, data, error } = mediaProcessingCompleteSchema.safeParse(
    req.body,
  );
  if (!success) {
    return errorResponse(res, 400, error.issues[0].message);
  }

  const { mediaId, jobId, status, errorMessage } = data;

  // Log details to media-processing.log
  const logFilePath = path.join(process.cwd(), "logs", "media-processing.log");
  try {
    await fs.mkdir(path.dirname(logFilePath), { recursive: true });
    const logEntry = {
      timestamp: new Date().toISOString(),
      mediaId,
      jobId,
      status,
      errorMessage,
      warnings: data.warnings,
    };
    await fs.appendFile(logFilePath, JSON.stringify(logEntry) + "\n", "utf8");
  } catch (err) {
    console.error("Failed to write to media-processing log file:", err);
  }

  try {
    const media = await Media.findById(mediaId);
    if (!media) {
      return errorResponse(res, 404, "Media record not found");
    }

    if (media.status === "READY") {
      return successResponse(res, 200, "Media already processed", { media });
    }

    if (status === "ERROR") {
      media.status = "FAILED";
      media.error = errorMessage || "MediaConvert job failed";
      media.jobId = jobId;
      await media.save();
      return successResponse(res, 200, "Media processing failure saved", {
        media,
      });
    }

    if (status === "COMPLETE") {
      let transferResult;
      try {
        // 1. Run the rclone transfer pipeline (multi-round, fault-tolerant)
        transferResult = await transferHlsToB2(mediaId);
      } catch (transferErr) {
        // A hard error here means rclone couldn't even start or S3 listing
        // failed — not a per-file copy failure. Mark as FAILED.
        console.error(
          `[mediaProcessCompleted] Transfer pipeline hard error for mediaId ${mediaId}:`,
          transferErr,
        );
        media.status = "FAILED";
        media.error = transferErr.message || "HLS transfer pipeline failed";
        media.jobId = jobId;
        await media.save();
        return errorResponse(res, 500, "HLS transfer pipeline failed");
      }

      // 2. Delete S3 objects that are CONFIRMED present in B2.
      //    Objects in transferResult.failedKeys are intentionally left in S3.
      await deleteConfirmedS3Objects(mediaId, transferResult.copiedKeys);

      if (transferResult.status === "READY") {
        // All objects copied — delete the original input video and mark READY.
        await deleteS3InputVideo(mediaId);

        media.status = "READY";
        media.jobId = jobId;
        media.copyAttempts = (media.copyAttempts ?? 0) + 1;
        await media.save();

        return successResponse(
          res,
          200,
          "Processing and transfer completed successfully",
          { media },
        );
      }

      // Partial transfer — some files are still missing in B2.
      // Do NOT mark as FAILED. Do NOT rerun MediaConvert.
      // Leave failed S3 objects intact for future recovery.
      console.warn(
        `[mediaProcessCompleted] Partial transfer for mediaId ${mediaId}: ` +
          `${transferResult.failedKeys.length}/${transferResult.totalObjects} objects missing. ` +
          `Status set to COPY_PENDING.`,
      );

      media.status = "COPY_PENDING";
      media.jobId = jobId;
      media.failedUploadLog = transferResult.logPath;
      media.copyAttempts = (media.copyAttempts ?? 0) + 1;
      await media.save();

      return successResponse(
        res,
        200,
        `MediaConvert succeeded. Transfer partially complete: ` +
          `${transferResult.failedKeys.length} file(s) still pending. ` +
          `Use the retry-transfer endpoint to recover.`,
        { media },
      );
    }

    return errorResponse(res, 400, "Unknown job status");
  } catch (err) {
    console.error("[mediaProcessCompleted] Unexpected error:", err);
    return errorResponse(
      res,
      500,
      "Failed to handle processing complete callback",
    );
  }
};

// POST /media/:id/retry-transfer  (ADMIN only)
export const retryMediaTransfer = async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f\d]{24}$/i.test(id))
    return errorResponse(res, 400, "Invalid media ID");

  try {
    const media = await Media.findById(id);
    if (!media) return errorResponse(res, 404, "Media record not found");

    if (media.status !== "COPY_PENDING") {
      return errorResponse(
        res,
        400,
        `Cannot retry transfer: media status is "${media.status}". ` +
          `Only COPY_PENDING media can be retried.`,
      );
    }

    console.log(
      `[retryMediaTransfer] Starting recovery for mediaId: ${id} ` +
        `(attempt ${(media.copyAttempts ?? 0) + 1})`,
    );

    let transferResult;
    try {
      transferResult = await retryFailedTransfers(id);
    } catch (err) {
      console.error(
        `[retryMediaTransfer] Recovery pipeline error for mediaId ${id}:`,
        err,
      );
      return errorResponse(res, 500, "Transfer retry pipeline failed");
    }

    // Delete any S3 objects that are now confirmed in B2
    await deleteConfirmedS3Objects(id, transferResult.copiedKeys);

    media.copyAttempts = (media.copyAttempts ?? 0) + 1;

    if (transferResult.status === "READY") {
      // Full recovery — delete the original input video and mark READY
      await deleteS3InputVideo(id);

      media.status = "READY";
      media.failedUploadLog = null;
      await media.save();

      return successResponse(
        res,
        200,
        "Transfer recovery complete. Media is now READY.",
        { media },
      );
    }

    // Still partially pending
    media.status = "COPY_PENDING";
    media.failedUploadLog = transferResult.logPath;
    await media.save();

    return successResponse(
      res,
      200,
      `Transfer still incomplete: ${transferResult.failedKeys.length} file(s) pending. ` +
        `Retry again later.`,
      {
        media,
        failedKeys: transferResult.failedKeys,
        totalObjects: transferResult.totalObjects,
      },
    );
  } catch (err) {
    console.error("[retryMediaTransfer] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to process transfer retry");
  }
};
