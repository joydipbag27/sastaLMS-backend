import {
  S3Client,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

export const s3Client = new S3Client({
  endpoint: process.env.BLACK_BLAZE_ENDPOINT,
  region: process.env.BLACK_BLAZE_REGION,
  credentials: {
    accessKeyId: process.env.BLACK_BLAZE_ACCESS_KEY_ID,
    secretAccessKey: process.env.BLACK_BLAZE_SECRET,
  },
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Splits an array into chunks of at most `size` elements. */
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/**
 * Sends one batch of delete requests (max 1 000 objects) to B2.
 * Errors are logged and never rethrown.
 */
const sendDeleteBatch = async (objects) => {
  if (objects.length === 0) return;
  try {
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: process.env.BUCKET_NAME,
        Delete: { Objects: objects, Quiet: true },
      })
    );
  } catch (err) {
    console.error("[B2 delete] DeleteObjectsCommand failed:", err.message ?? err);
  }
};

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Permanently deletes every object whose key starts with any of the given
 * prefixes from the B2 bucket.  Handles both versioned and non-versioned
 * buckets.
 *
 * For HLS media the caller passes a single folder prefix such as
 *   ["videos/<mediaId>/"]
 * and this function discovers and deletes all .m3u8 / .ts files underneath.
 *
 * Two-pass strategy
 * ─────────────────
 * Pass 1 — ListObjectsV2  (current / live objects)
 *   Lists every object key under the prefix and collects them for deletion.
 *   Works regardless of whether bucket versioning is enabled.
 *   Paginates until IsTruncated = false.
 *
 * Pass 2 — ListObjectVersions  (stale versions + delete markers)
 *   For versioned buckets: collects any non-current versions and delete
 *   markers left behind by previous deletes.  Uses version.Key / marker.Key
 *   (the actual object key) — NOT the prefix string, which was the
 *   original bug.
 *
 * Both passes batch-delete in chunks of 1 000 (S3 API limit).
 * All errors are logged and never rethrown so that cascading operations
 * (section/course deletion) continue even if a single file cleanup fails.
 *
 * @param {string[]} prefixes  e.g. ["videos/<mediaId>/"]
 * @returns {Promise<void>}
 */
export const permanentlyDeleteMultipleFromB2 = async (prefixes) => {
  if (!prefixes || prefixes.length === 0) return;

  const bucket = process.env.BUCKET_NAME;
  if (!bucket) {
    console.error("[B2 delete] BUCKET_NAME env var is not set — aborting");
    return;
  }

  for (const prefix of prefixes) {
    // ── Pass 1: list and delete current (live) objects ──────────────────────
    let liveObjectCount = 0;
    let continuationToken;

    do {
      let listResponse;
      try {
        listResponse = await s3Client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          })
        );
      } catch (err) {
        console.error(`[B2 delete] ListObjectsV2 failed for prefix "${prefix}":`, err.message ?? err);
        break;
      }

      const objects = (listResponse.Contents ?? []).map((obj) => ({ Key: obj.Key }));
      liveObjectCount += objects.length;

      // Delete this page's worth immediately so we don't accumulate all keys in memory
      for (const batch of chunk(objects, 1000)) {
        await sendDeleteBatch(batch);
      }

      continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
    } while (continuationToken);

    // ── Pass 2: clean up stale versions and delete markers (versioned buckets) ─
    let versionContinuationToken;
    let extraCount = 0;

    do {
      let versionsResponse;
      try {
        versionsResponse = await s3Client.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: prefix,
            KeyMarker: versionContinuationToken,
          })
        );
      } catch (err) {
        // If the bucket doesn't support versioning B2 may return an error — that's fine
        console.warn(`[B2 delete] ListObjectVersions failed for prefix "${prefix}" (non-versioned bucket?):`, err.message ?? err);
        break;
      }

      const versionObjects = [];

      for (const v of versionsResponse.Versions ?? []) {
        // CRITICAL: use v.Key (the real object key) — NOT the prefix string
        versionObjects.push({ Key: v.Key, VersionId: v.VersionId });
      }
      for (const m of versionsResponse.DeleteMarkers ?? []) {
        versionObjects.push({ Key: m.Key, VersionId: m.VersionId });
      }

      extraCount += versionObjects.length;

      for (const batch of chunk(versionObjects, 1000)) {
        await sendDeleteBatch(batch);
      }

      versionContinuationToken = versionsResponse.IsTruncated
        ? versionsResponse.NextKeyMarker
        : undefined;
    } while (versionContinuationToken);

    console.log(
      `[B2 delete] Prefix "${prefix}": deleted ${liveObjectCount} live object(s)` +
      (extraCount > 0 ? `, ${extraCount} stale version(s)/marker(s)` : "")
    );
  }
};
