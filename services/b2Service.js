/**
 * b2Service.js
 *
 * S3 asset deletion utilities for the media pipeline.
 *
 * The S3 → B2 copy logic previously in this file has been replaced by
 * rcloneTransferService.js. This file retains only the AWS S3 cleanup
 * operations used after a successful (or partial) transfer.
 *
 * INVARIANT: An S3 object is NEVER deleted unless it has been explicitly
 * confirmed as present in Backblaze B2 by the transfer service.
 */

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { awsS3Client } from "../config/awsS3Client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Chunk helper
// ─────────────────────────────────────────────────────────────────────────────

/** Splits an array into chunks of at most `size` elements. */
const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deletes a specific list of output keys from the MediaConvert output bucket.
 *
 * This is the primary deletion utility used by the transfer pipeline.
 * It must ONLY be called with keys that have been confirmed as present in B2
 * by the transfer service — never with failed keys.
 *
 * Batch deletion is chunked to stay within the S3 1,000-key API limit.
 * Errors are logged but never rethrown (best-effort cleanup).
 *
 * @param {string}   mediaId       - Used for log messages only
 * @param {string[]} confirmedKeys - Keys confirmed in B2 that are safe to delete
 * @returns {Promise<void>}
 */
export const deleteConfirmedS3Objects = async (mediaId, confirmedKeys) => {
  const outputBucket = process.env.MEDIACONVERT_OUTPUT_BUCKET;

  if (!confirmedKeys || confirmedKeys.length === 0) {
    console.log(
      `[b2Service] deleteConfirmedS3Objects: no keys to delete for mediaId ${mediaId}`
    );
    return;
  }

  console.log(
    `[b2Service] Deleting ${confirmedKeys.length} confirmed S3 objects for mediaId ${mediaId}`
  );

  const chunks = chunkArray(confirmedKeys, 1000);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      await awsS3Client.send(
        new DeleteObjectsCommand({
          Bucket: outputBucket,
          Delete: {
            Objects: chunk.map((key) => ({ Key: key })),
            Quiet: true,
          },
        })
      );
      console.log(
        `[b2Service] Deleted output chunk ${i + 1}/${chunks.length}: ` +
          `${chunk.length} objects from s3://${outputBucket}/`
      );
    } catch (err) {
      console.error(
        `[b2Service] Failed to delete output chunk ${i + 1}/${chunks.length} ` +
          `for mediaId ${mediaId}:`,
        err.message
      );
    }
  }
};

/**
 * Deletes the original raw input video from the MediaConvert input bucket.
 *
 * This is called only after the entire HLS output has been confirmed
 * in B2 (i.e., Media.status reaches READY).
 *
 * Errors are logged but never rethrown.
 *
 * @param {string} mediaId - The media ID (= input object key in the input bucket)
 * @returns {Promise<void>}
 */
export const deleteS3InputVideo = async (mediaId) => {
  const inputBucket = process.env.MEDIACONVERT_INPUT_BUCKET;

  try {
    await awsS3Client.send(
      new DeleteObjectCommand({ Bucket: inputBucket, Key: mediaId })
    );
    console.log(
      `[b2Service] Deleted input video: s3://${inputBucket}/${mediaId}`
    );
  } catch (err) {
    console.error(
      `[b2Service] Failed to delete input video ${mediaId} from ${inputBucket}:`,
      err.message
    );
  }
};
