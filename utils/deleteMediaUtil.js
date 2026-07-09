/**
 * deleteMediaUtil.js
 *
 * Single authoritative utility for deleting all storage artefacts
 * of a VIDEO Media document, branching correctly on status + storageProvider.
 *
 * Imports both the B2 client (s3Client.js) and the AWS client (awsS3Client.js)
 * at the top level to avoid any circular-dependency or dynamic-import issues.
 *
 * ─── Storage locations by pipeline state ─────────────────────────────────────
 *
 *  UPLOADING   + BACKBLAZE  → raw video in S3 input bucket only (not yet processed)
 *  PROCESSING  + BACKBLAZE  → raw video in S3 input bucket
 *                             + HLS output *may* exist in S3 output bucket
 *  COPY_PENDING+ BACKBLAZE  → partial HLS in B2 (videos/{mediaId}/)
 *                             + remaining HLS still in S3 output bucket
 *  READY       + BACKBLAZE  → HLS folder in B2 only (S3 cleaned by pipeline)
 *  FAILED      + BACKBLAZE  → raw video may still be in S3 input bucket
 *  AWS_S3      storageProvider → thumbnails only — handled by deleteThumbnailFromS3
 *
 * ─── Safety ──────────────────────────────────────────────────────────────────
 *
 * All storage errors are logged but NOT rethrown, so cascading deletions
 * (section/course) continue even if a single media cleanup fails.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 * import { deleteMediaFromStorage } from "../utils/deleteMediaUtil.js";
 * await deleteMediaFromStorage(media);   // media = Mongoose Media document
 */

import { permanentlyDeleteMultipleFromB2 } from "../config/s3Client.js";
import {
  deleteVideoFromS3,
  deleteHlsOutputFromS3,
} from "../config/awsS3Client.js";

/**
 * Deletes all storage artefacts for a single VIDEO Media document.
 *
 * @param {object} media  - Mongoose Media document (or lean object with _id, status, storageProvider)
 * @returns {Promise<void>}
 */
export const deleteMediaFromStorage = async (media) => {
  if (!media) return;

  // Thumbnails use a separate S3 bucket and are managed by deleteThumbnailFromS3
  if (media.storageProvider === "AWS_S3") return;

  const mediaId = media._id.toString();

  switch (media.status) {
    case "READY":
      // All HLS files live in B2 under videos/{mediaId}/.
      // The S3 input and output buckets were already cleaned by the pipeline.
      await permanentlyDeleteMultipleFromB2([`videos/${mediaId}/`]);
      break;

    case "COPY_PENDING":
      // Partial transfer completed: some files reached B2, some are still
      // in the S3 output bucket. Delete from both locations concurrently.
      await Promise.all([
        permanentlyDeleteMultipleFromB2([`videos/${mediaId}/`]),
        deleteHlsOutputFromS3(mediaId),
      ]);
      break;

    case "PROCESSING":
      // MediaConvert job ran (or is running). The raw input is in S3 input bucket.
      // HLS output may or may not exist yet in the S3 output bucket.
      // Delete both concurrently; deleteHlsOutputFromS3 is a no-op if nothing is there.
      await Promise.all([
        deleteVideoFromS3(mediaId),      // S3 input bucket: raw video
        deleteHlsOutputFromS3(mediaId),  // S3 output bucket: HLS folder (may be empty)
      ]);
      break;

    case "UPLOADING":
    case "FAILED":
    default:
      // Raw video is (or was) in the S3 input bucket.
      // Nothing has been written to the output bucket or B2 yet.
      await deleteVideoFromS3(mediaId);
      break;
  }
};
