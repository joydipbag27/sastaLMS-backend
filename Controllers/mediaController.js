import crypto from "node:crypto";
import { PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, permanentlyDeleteMultipleFromB2 } from "../config/s3Client.js";
import Media from "../Models/mediaModel.js";
import { uploadUrlSchema, confirmUploadSchema } from "../validators/mediaSchema.js";
import { successResponse, errorResponse } from "../utils/response.js";

// POST /media/upload-url
export const getMediaUploadUrl = async (req, res) => {
  const { success, data, error } = uploadUrlSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  try {
    const storageKey = `${crypto.randomUUID()}`;

    const command = new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: storageKey,
      ContentType: data.mimeType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    return successResponse(res, 200, "Upload URL generated", { uploadUrl, storageKey });
  } catch (err) {
    console.error("[getMediaUploadUrl] Failed to generate presigned PUT URL:", err);
    return errorResponse(res, 500, "Failed to generate upload URL");
  }
};

// POST /media/confirm-upload
export const confirmMediaUpload = async (req, res) => {
  const { success, data, error } = confirmUploadSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  try {
    // Verify file exists on B2/S3 and size matches
    const headCommand = new HeadObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: data.storageKey,
    });

    let s3Data;
    try {
      s3Data = await s3Client.send(headCommand);
    } catch (err) {
      console.error("[confirmMediaUpload] File lookup failed on B2. Cleaning up:", err);
      await permanentlyDeleteMultipleFromB2([data.storageKey]);
      return errorResponse(res, 400, "File does not exist on storage");
    }

    if (s3Data.ContentLength !== data.size) {
      console.error(`[confirmMediaUpload] File size mismatch: expected ${data.size}, got ${s3Data.ContentLength}`);
      await permanentlyDeleteMultipleFromB2([data.storageKey]);
      return errorResponse(res, 400, "File size mismatch on storage");
    }

    const media = await Media.create({
      uploadedBy: req.user._id,
      storageKey: data.storageKey,
      mimeType: data.mimeType,
      size: data.size,
      status: "READY",
    });

    return successResponse(res, 201, "Media confirmed", { media });
  } catch (err) {
    console.error("[confirmMediaUpload] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to confirm upload");
  }
};

// GET /media/:id/download
export const getMediaDownloadUrl = async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f\d]{24}$/i.test(id)) return errorResponse(res, 400, "Invalid media ID");

  try {
    const media = await Media.findById(id);
    if (!media) return errorResponse(res, 404, "Media not found");

    const command = new GetObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: media.storageKey,
    });

    const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    return successResponse(res, 200, "Download URL generated", { downloadUrl });
  } catch (err) {
    console.error("[getMediaDownloadUrl] Failed to generate presigned GET URL:", err);
    return errorResponse(res, 500, "Failed to generate download URL");
  }
};

// DELETE /media/:id
export const deleteMedia = async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f\d]{24}$/i.test(id)) return errorResponse(res, 400, "Invalid media ID");

  try {
    const media = await Media.findById(id);
    if (!media) return errorResponse(res, 404, "Media not found");

    // Only uploader or ADMIN may delete
    if (
      req.user.role !== "ADMIN" &&
      media.uploadedBy.toString() !== req.user._id.toString()
    ) {
      return errorResponse(res, 403, "You do not have permission to delete this media");
    }

    await permanentlyDeleteMultipleFromB2([media.storageKey]);
    await media.deleteOne();

    return successResponse(res, 200, "Media deleted successfully");
  } catch (err) {
    console.error("[deleteMedia] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to delete media");
  }
};
