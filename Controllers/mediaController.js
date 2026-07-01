import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
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
  uploadUrlSchema,
  confirmUploadSchema,
  uploadCompleteSchema,
  mediaProcessingCompleteSchema,
} from "../validators/mediaSchema.js";
import { successResponse, errorResponse } from "../utils/response.js";
import { createJob } from "../services/mediaConvertService.js";

// POST /media/lesson/:lessonId/upload-url
export const getLessonVideoUploadUrl = async (req, res) => {
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

    // Create a draft Media document — its _id becomes the B2 key
    const media = await Media.create({
      uploadedBy: req.user._id,
      mimeType: data.mimeType,
      size: 0,
      status: "UPLOADING",
    });

    const key = media._id.toString();

    const command = new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: key,
      ContentType: data.mimeType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600,
    });

    return successResponse(res, 200, "Upload URL generated", {
      uploadUrl,
      mediaId: key,
    });
  } catch (err) {
    console.error(
      "[getLessonVideoUploadUrl] Failed to generate presigned PUT URL:",
      err,
    );
    return errorResponse(res, 500, "Failed to generate upload URL");
  }
};

// POST /media/lesson/:lessonId/replace-url
export const getLessonVideoReplaceUrl = async (req, res) => {
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
      await permanentlyDeleteMultipleFromB2([oldMediaId.toString()]);
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

    // Create a draft Media document — its _id becomes the B2 key
    const media = await Media.create({
      uploadedBy: req.user._id,
      mimeType: data.mimeType,
      size: 0,
      status: "UPLOADING",
    });

    const key = media._id.toString();

    const command = new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: key,
      ContentType: data.mimeType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600,
    });

    return successResponse(res, 200, "Replace URL generated", {
      uploadUrl,
      mediaId: key,
    });
  } catch (err) {
    console.error(
      "[getLessonVideoReplaceUrl] Failed to generate presigned PUT URL:",
      err,
    );
    return errorResponse(res, 500, "Failed to generate replace URL");
  }
};

// POST /media/lesson/:lessonId/confirm
export const confirmLessonVideoUpload = async (req, res) => {
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

    // Verify file exists on B2 and size matches
    const headCommand = new HeadObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: key,
    });

    let s3Data;
    try {
      s3Data = await s3Client.send(headCommand);
    } catch (err) {
      console.error(
        "[confirmLessonVideoUpload] File lookup failed on B2. Cleaning up:",
        err,
      );
      await media.deleteOne();
      return errorResponse(res, 400, "File does not exist on storage");
    }

    if (s3Data.ContentLength !== data.size) {
      console.error(
        `[confirmLessonVideoUpload] File size mismatch: expected ${data.size}, got ${s3Data.ContentLength}`,
      );
      await permanentlyDeleteMultipleFromB2([key]);
      await media.deleteOne();
      return errorResponse(res, 400, "File size mismatch on storage");
    }

    media.mimeType = data.mimeType;
    media.size = data.size;
    media.status = "READY";
    await media.save();

    // Associate media with lesson and clean up old media if exists
    const oldMediaId = lesson.video;
    lesson.video = media._id;
    await lesson.save();

    if (oldMediaId && oldMediaId.toString() !== media._id.toString()) {
      const oldMedia = await Media.findById(oldMediaId);
      if (oldMedia) {
        await permanentlyDeleteMultipleFromB2([oldMediaId.toString()]);
        await oldMedia.deleteOne();
      }
    }

    const updatedLesson = await Lesson.findById(lessonId).populate("video");
    return successResponse(
      res,
      200,
      "Lesson video upload confirmed and associated successfully",
      { lesson: updatedLesson, media },
    );
  } catch (err) {
    console.error("[confirmLessonVideoUpload] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to confirm upload");
  }
};

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
    media.status = "READY";
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
        Bucket: process.env.AWS_VIDEO_BUCKET,
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

  const { success, data, error } = mediaProcessingCompleteSchema.safeParse(req.body);
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
      return successResponse(res, 200, "Media processing failure saved", { media });
    }

    if (status === "COMPLETE") {
      console.log(`Processing completed for mediaId: ${mediaId}`);
      media.status = "READY";
      media.jobId = jobId;
      await media.save();
      return successResponse(res, 200, "Processing completed successfully", { media });
    }

    return errorResponse(res, 400, "Unknown job status");
  } catch (err) {
    console.error("[mediaProcessCompleted] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to handle processing complete callback");
  }
};