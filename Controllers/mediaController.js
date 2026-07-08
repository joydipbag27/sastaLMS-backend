import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
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
import { calculateHlsDurationFromS3 } from "../services/durationService.js";

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
      storageProvider: "BACKBLAZE",
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

    if (req.user.role !== "ADMIN" && media.uploadedBy.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to confirm this media");
    }

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



// Helper to finalize B2 validation, compute authoritative size/duration, validate MIME type, and mark READY
const finalizeB2VerificationAndReady = async (media, jobId) => {
  const mediaId = media._id.toString();
  const bucket = process.env.BUCKET_NAME;

  // 1. List B2 objects under videos/{mediaId}/ (handling pagination)
  let isTruncated = true;
  let continuationToken;
  const b2Objects = [];
  while (isTruncated) {
    const listParams = {
      Bucket: bucket,
      Prefix: `videos/${mediaId}/`,
      ContinuationToken: continuationToken,
    };
    const listResponse = await s3Client.send(new ListObjectsV2Command(listParams));
    if (listResponse.Contents) {
      b2Objects.push(...listResponse.Contents);
    }
    isTruncated = listResponse.IsTruncated;
    continuationToken = listResponse.NextContinuationToken;
  }

  // 2. Verify master playlist exists and has correct Content-Type
  const masterKey = `videos/${mediaId}/${mediaId}.m3u8`;
  const objectKeys = new Set(b2Objects.map(obj => obj.Key));
  if (!objectKeys.has(masterKey)) {
    throw new Error(`Master playlist not found in B2: ${masterKey}`);
  }

  const headResponse = await s3Client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: masterKey,
    })
  );

  const rawContentType = headResponse.ContentType;
  const normalizedMime = rawContentType
    ?.toLowerCase()
    .split(";")[0]
    .trim();

  if (normalizedMime !== "application/vnd.apple.mpegurl") {
    throw new Error(`Invalid master playlist Content-Type: ${rawContentType}`);
  }

  // 3. Calculate total processed folder size
  const calculatedFinalB2FolderSize = b2Objects.reduce((acc, obj) => acc + (obj.Size || 0), 0);

  // 4. Calculate duration from S3 (existing approach)
  const duration = await calculateHlsDurationFromS3(mediaId);

  // 5. Update Media document atomically
  media.status = "READY";
  media.size = calculatedFinalB2FolderSize;
  media.duration = duration;
  media.mimeType = "application/vnd.apple.mpegurl";
  if (jobId) {
    media.jobId = jobId;
  }
  media.failedUploadLog = null;
  media.copyAttempts = (media.copyAttempts ?? 0) + 1;
  await media.save();

  // 6. Sync duration with any associated Lesson documents
  await Lesson.updateMany({ video: media._id }, { duration });

  return media;
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

      if (transferResult.status === "READY") {
        // 2. Authoritative validation and updates from final B2 output
        try {
          await finalizeB2VerificationAndReady(media, jobId);
        } catch (readyErr) {
          console.error(
            `[mediaProcessCompleted] B2 verification/finalize failed for mediaId ${mediaId}:`,
            readyErr,
          );
          return errorResponse(
            res,
            500,
            `B2 verification failed: ${readyErr.message}`,
          );
        }

        // 3. Cleanup S3 files only after database update succeeds
        await deleteConfirmedS3Objects(mediaId, transferResult.copiedKeys);
        await deleteS3InputVideo(mediaId);

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

      // Delete only what was successfully copied to B2
      await deleteConfirmedS3Objects(mediaId, transferResult.copiedKeys);

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

    if (transferResult.status === "READY") {
      // 1. Authoritative validation and updates from final B2 output
      try {
        await finalizeB2VerificationAndReady(media);
      } catch (readyErr) {
        console.error(
          `[retryMediaTransfer] B2 verification/finalize failed for mediaId ${id}:`,
          readyErr,
        );
        return errorResponse(
          res,
          500,
          `B2 verification failed during retry: ${readyErr.message}`,
        );
      }

      // 2. Cleanup S3 files only after database update succeeds
      await deleteConfirmedS3Objects(id, transferResult.copiedKeys);
      await deleteS3InputVideo(id);

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
    media.copyAttempts = (media.copyAttempts ?? 0) + 1;
    await media.save();

    // Delete only what was successfully copied to B2
    await deleteConfirmedS3Objects(id, transferResult.copiedKeys);

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
