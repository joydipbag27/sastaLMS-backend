import { HeadObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { s3Client, permanentlyDeleteMultipleFromB2 } from "../config/s3Client.js";
import { deleteVideoFromS3 } from "../config/awsS3Client.js";
import Media from "../Models/mediaModel.js";
import Lesson from "../Models/lessonModel.js";
import Course from "../Models/courseModel.js";
import { parsePlaylistDuration } from "../services/durationService.js";
import { successResponse, errorResponse } from "../utils/response.js";

/**
 * Normalizes Content-Type header values by stripping parameters,
 * converting to lowercase, and trimming whitespace.
 */
const normalizeContentType = (value) => {
  return value
    ?.toLowerCase()
    .split(";")[0]
    .trim();
};

/**
 * Helper to fetch a single B2 object's Content-Type metadata and verify it.
 * Throws a structured error if MIME verification fails.
 */
const verifyObjectMimeType = async (bucket, key, expectedMime) => {
  try {
    const headResponse = await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    const rawContentType = headResponse.ContentType;
    const normalized = normalizeContentType(rawContentType);

    if (!normalized) {
      const err = new Error("Missing Content-Type metadata");
      err.key = key;
      err.expected = expectedMime;
      err.actual = "none";
      throw err;
    }

    if (normalized !== expectedMime) {
      const err = new Error("Mismatched Content-Type metadata");
      err.key = key;
      err.expected = expectedMime;
      err.actual = rawContentType;
      throw err;
    }
  } catch (err) {
    if (err.key) throw err; // Already formatted S3/MIME error
    
    // S3 fetch error (e.g. 404 or credentials)
    const wrapErr = new Error(err.message || "Failed to fetch object metadata");
    wrapErr.key = key;
    wrapErr.expected = expectedMime;
    wrapErr.actual = "unknown";
    throw wrapErr;
  }
};

/**
 * Validates and parses HLS variant playlists content.
 * Checks for:
 * - At least one segment reference.
 * - Valid EXTINF entries.
 * - No external URLs (containing '://'), absolute paths (starting with '/'), or directory traversals ('..').
 * Returns the list of referenced segment keys.
 */
const parseAndValidatePlaylist = (content, mediaId) => {
  if (!content || !content.trim()) {
    throw new Error("Playlist is empty");
  }

  const lines = content.split(/\r?\n/);
  const segments = [];
  let hasExtInf = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.toUpperCase().startsWith("#EXTINF:")) {
      const durationPart = trimmed.slice(8).split(",")[0].trim();
      const duration = parseFloat(durationPart);
      if (isNaN(duration) || duration <= 0) {
        throw new Error("Invalid EXTINF duration entry");
      }
      hasExtInf = true;
    } else if (trimmed.startsWith("#")) {
      // Skip other headers/comments
      continue;
    } else {
      // This is a segment reference line
      // Security check: reject arbitrary external URLs, absolute paths, or traversal paths
      if (trimmed.includes("://") || trimmed.startsWith("/") || trimmed.includes("..")) {
        throw new Error(`Forbidden segment path reference: ${trimmed}`);
      }
      segments.push(trimmed);
    }
  }

  if (segments.length === 0) {
    throw new Error("No media segments found in playlist");
  }

  if (!hasExtInf) {
    throw new Error("No valid EXTINF duration entries found");
  }

  return segments;
};

/**
 * Endpoint 1: POST /media/manual
 * Creates media metadata for the manual flow and associates it with a lesson.
 * Does not require size or duration (they will be calculated upon verification).
 */
export const createManualMedia = async (req, res) => {
  const { lessonId } = req.body;

  if (!lessonId) {
    return errorResponse(res, 400, "Missing required fields");
  }

  if (!/^[a-f\d]{24}$/i.test(lessonId)) {
    return errorResponse(res, 400, "Invalid lesson ID");
  }

  try {
    const lesson = await Lesson.findById(lessonId);
    if (!lesson) {
      return errorResponse(res, 404, "Lesson not found");
    }

    const course = await Course.findById(lesson.course);
    if (!course) {
      return errorResponse(res, 404, "Associated course not found");
    }

    // Verify creator authorization (Admin or Course Creator)
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

    // Create the Media document in PROCESSING state (the appropriate pending state)
    const media = await Media.create({
      uploadedBy: req.user._id,
      size: null, // calculated later
      status: "PROCESSING",
      type: "VIDEO",
      storageProvider: "BACKBLAZE",
      ingestionMethod: "MANUAL",
    });

    const mediaId = media._id.toString();

    // Associate media with lesson and cleanup old media if exists
    const oldMediaId = lesson.video;
    lesson.video = media._id;
    await lesson.save();

    if (oldMediaId && oldMediaId.toString() !== mediaId) {
      const oldMedia = await Media.findById(oldMediaId);
      if (oldMedia) {
        if (oldMedia.storageProvider === "AWS_S3") {
          await deleteVideoFromS3(oldMediaId.toString());
        } else {
          await permanentlyDeleteMultipleFromB2([`videos/${oldMediaId.toString()}/`]);
        }
        await oldMedia.deleteOne();
      }
    }

    return successResponse(res, 201, "Manual media metadata created successfully", {
      mediaId,
    });
  } catch (err) {
    console.error("[createManualMedia] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to create manual media metadata");
  }
};

/**
 * Endpoint 2: POST /media/manual/:mediaId/verify
 * Verifies that the required HLS objects are uploaded to Backblaze B2,
 * parses duration and size, updates lesson and media, and marks it READY.
 * Fully idempotent to support safe retries.
 */
export const verifyManualMedia = async (req, res) => {
  const { mediaId } = req.params;

  if (!/^[a-f\d]{24}$/i.test(mediaId)) {
    return errorResponse(res, 400, "Invalid media ID");
  }

  try {
    const media = await Media.findById(mediaId);
    if (!media) {
      return errorResponse(res, 404, "Media document not found");
    }

    // Ensure this media belongs to the manual ingestion flow
    if (media.ingestionMethod !== "MANUAL") {
      return errorResponse(res, 400, "This media does not belong to the manual ingestion flow");
    }

    // Authorize: Admin or the owner creator
    if (
      req.user.role !== "ADMIN" &&
      media.uploadedBy.toString() !== req.user._id.toString()
    ) {
      return errorResponse(
        res,
        403,
        "You do not have permission to verify this media",
      );
    }

    const bucket = process.env.BUCKET_NAME;
    if (!bucket) {
      return errorResponse(res, 500, "B2 bucket is not configured on backend");
    }

    // 1. List all B2 objects under the prefix
    const prefix = `videos/${mediaId}/`;
    let isTruncated = true;
    let continuationToken;
    const b2Objects = [];

    while (isTruncated) {
      const listParams = {
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      };

      const listResponse = await s3Client.send(new ListObjectsV2Command(listParams));
      if (listResponse.Contents) {
        b2Objects.push(...listResponse.Contents);
      }

      isTruncated = listResponse.IsTruncated;
      continuationToken = listResponse.NextContinuationToken;
    }

    // Create a Set of existing B2 keys for fast checks
    const objectKeys = new Set(b2Objects.map(obj => obj.Key));

    // Expected playlist keys
    const masterPlaylistKey = `videos/${mediaId}/${mediaId}.m3u8`;
    const playlist360Key = `videos/${mediaId}/${mediaId}_360p.m3u8`;
    const playlist720Key = `videos/${mediaId}/${mediaId}_720p.m3u8`;

    // 2. Verify all three playlists exist
    if (!objectKeys.has(masterPlaylistKey)) {
      return errorResponse(res, 400, `Verification failed: master playlist not found: ${masterPlaylistKey}`);
    }
    if (!objectKeys.has(playlist360Key)) {
      return errorResponse(res, 400, `Verification failed: 360p playlist not found: ${playlist360Key}`);
    }
    if (!objectKeys.has(playlist720Key)) {
      return errorResponse(res, 400, `Verification failed: 720p playlist not found: ${playlist720Key}`);
    }

    // Helper to fetch playlist content from B2
    const fetchPlaylistContent = async (key) => {
      const getObjectResponse = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      if (getObjectResponse.Body) {
        return await getObjectResponse.Body.transformToString("utf-8");
      }
      throw new Error(`Empty body returned for key: ${key}`);
    };

    // 3. Fetch playlists
    let content360, content720;
    try {
      content360 = await fetchPlaylistContent(playlist360Key);
      content720 = await fetchPlaylistContent(playlist720Key);
    } catch (fetchErr) {
      console.error("[verifyManualMedia] Failed to fetch playlists:", fetchErr);
      return errorResponse(res, 400, `Verification failed: unable to fetch playlists: ${fetchErr.message}`);
    }

    // 4. Validate playlists and collect referenced segments
    let segments360 = [];
    let segments720 = [];
    try {
      segments360 = parseAndValidatePlaylist(content360, mediaId);
      segments720 = parseAndValidatePlaylist(content720, mediaId);
    } catch (validationErr) {
      console.error("[verifyManualMedia] Playlist structural validation failed:", validationErr);
      return errorResponse(res, 400, `Verification failed: playlist format error: ${validationErr.message}`);
    }

    // 5. Verify every referenced segment exists in the B2 object listing
    for (const segment of segments360) {
      const segmentKey = `videos/${mediaId}/${segment}`;
      if (!objectKeys.has(segmentKey)) {
        return errorResponse(res, 400, `Verification failed: referenced 360p segment is missing: ${segmentKey}`);
      }
    }
    for (const segment of segments720) {
      const segmentKey = `videos/${mediaId}/${segment}`;
      if (!objectKeys.has(segmentKey)) {
        return errorResponse(res, 400, `Verification failed: referenced 720p segment is missing: ${segmentKey}`);
      }
    }

    // 6. Verify Content-Type metadata of required HLS objects on B2
    try {
      // Validate playlists MIME types
      await verifyObjectMimeType(bucket, masterPlaylistKey, "application/vnd.apple.mpegurl");
      await verifyObjectMimeType(bucket, playlist360Key, "application/vnd.apple.mpegurl");
      await verifyObjectMimeType(bucket, playlist720Key, "application/vnd.apple.mpegurl");

      // Validate all referenced segments MIME types
      const allUniqueSegments = new Set([...segments360, ...segments720]);
      
      // Process segment head requests cleanly (could batch/concurrency limit here if needed)
      for (const segment of allUniqueSegments) {
        const segmentKey = `videos/${mediaId}/${segment}`;
        await verifyObjectMimeType(bucket, segmentKey, "video/mp2t");
      }
    } catch (mimeErr) {
      console.error("[verifyManualMedia] MIME type validation failed:", mimeErr);
      return res.status(400).json({
        success: false,
        message: "Invalid Content-Type for manual HLS object",
        details: {
          key: mimeErr.key,
          expected: mimeErr.expected,
          actual: mimeErr.actual,
        },
      });
    }

    // 7. Calculate total folder size
    const calculatedTotalB2Size = b2Objects.reduce((acc, obj) => acc + (obj.Size || 0), 0);

    // 8. Calculate duration from the 720p playlist
    const calculatedHLSDuration = parsePlaylistDuration(content720);

    // 9. Update Media document
    media.status = "READY";
    media.size = calculatedTotalB2Size;
    media.duration = calculatedHLSDuration;
    media.mimeType = "application/vnd.apple.mpegurl";
    await media.save();

    // 10. Sync duration with associated Lesson documents
    await Lesson.updateMany({ video: media._id }, { duration: calculatedHLSDuration });

    return successResponse(res, 200, "Media verified and marked READY", { media });
  } catch (err) {
    console.error("[verifyManualMedia] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to verify manual media");
  }
};
