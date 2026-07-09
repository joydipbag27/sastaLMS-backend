import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const awsS3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export const generateThumbnailUploadUrl = async (mediaId, mimeType) => {
  const objectKey = `course-thumbnails/${mediaId}`;
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_THUMBNAIL_BUCKET,
    Key: objectKey,
    ContentType: mimeType,
  });
  const uploadUrl = await getSignedUrl(awsS3Client, command, {
    expiresIn: 3600,
  });
  return { uploadUrl, objectKey };
};

export const deleteThumbnailFromS3 = async (mediaId) => {
  const objectKey = `course-thumbnails/${mediaId}`;
  try {
    await awsS3Client.send(
      new DeleteObjectCommand({
        Bucket: process.env.AWS_THUMBNAIL_BUCKET,
        Key: objectKey,
      }),
    );
  } catch (err) {
    console.error(`Failed to delete thumbnail ${objectKey} from S3:`, err);
  }
};

export const getThumbnailMetadata = async (mediaId) => {
  const objectKey = `course-thumbnails/${mediaId}`;
  const command = new HeadObjectCommand({
    Bucket: process.env.AWS_THUMBNAIL_BUCKET,
    Key: objectKey,
  });
  const metadata = await awsS3Client.send(command);
  return {
    contentType: metadata.ContentType,
    contentLength: metadata.ContentLength,
  };
};

export const generateVideoUploadUrlS3 = async (mediaId, mimeType) => {
  const command = new PutObjectCommand({
    Bucket: process.env.MEDIACONVERT_INPUT_BUCKET,
    Key: mediaId,
    ContentType: mimeType,
  });
  const uploadUrl = await getSignedUrl(awsS3Client, command, {
    expiresIn: 3600,
  });
  return { uploadUrl };
};

export const getVideoMetadataFromS3 = async (mediaId) => {
  const command = new HeadObjectCommand({
    Bucket: process.env.MEDIACONVERT_INPUT_BUCKET,
    Key: mediaId,
  });
  const metadata = await awsS3Client.send(command);
  return {
    contentType: metadata.ContentType,
    contentLength: metadata.ContentLength,
  };
};

export const deleteVideoFromS3 = async (mediaId) => {
  await permanentlyDeleteMultipleFromS3([mediaId]);
};

export const permanentlyDeleteMultipleFromS3 = async (keys) => {
  if (!keys || keys.length === 0) return;

  const objectsToDelete = [];

  for (const key of keys) {
    let versionsData = null;
    try {
      versionsData = await awsS3Client.send(
        new ListObjectVersionsCommand({
          Bucket: process.env.MEDIACONVERT_INPUT_BUCKET,
          Prefix: key,
        }),
      );
    } catch (err) {
      console.error(
        `Failed to list object versions for key ${key} from S3:`,
        err,
      );
    }

    let versionsFound = false;

    if (versionsData) {
      if (versionsData.Versions && versionsData.Versions.length > 0) {
        versionsFound = true;
        for (const version of versionsData.Versions) {
          objectsToDelete.push({
            Key: key,
            VersionId: version.VersionId,
          });
        }
      }

      if (versionsData.DeleteMarkers && versionsData.DeleteMarkers.length > 0) {
        versionsFound = true;
        for (const marker of versionsData.DeleteMarkers) {
          objectsToDelete.push({
            Key: key,
            VersionId: marker.VersionId,
          });
        }
      }
    }

    // Fallback: If no versions/markers were listed/returned, queue the key for simple deletion without versionId
    if (!versionsFound) {
      objectsToDelete.push({ Key: key });
    }
  }

  if (objectsToDelete.length === 0) return;

  try {
    await awsS3Client.send(
      new DeleteObjectsCommand({
        Bucket: process.env.MEDIACONVERT_INPUT_BUCKET,
        Delete: {
          Objects: objectsToDelete,
          Quiet: true,
        },
      }),
    );
  } catch (err) {
    console.error("Failed to delete objects from S3:", err);
  }
};

/**
 * Deletes all HLS output files for a given mediaId from the MediaConvert
 * OUTPUT bucket (e.g. videos/{mediaId}/*.m3u8, *.ts segments, etc.).
 *
 * The output bucket is a standard (non-versioned) bucket written to by
 * MediaConvert. We list with ListObjectsV2Command and batch-delete.
 *
 * Called when a video in PROCESSING or COPY_PENDING state is deleted,
 * because MediaConvert may already have written output that was not yet
 * transferred to B2.
 *
 * @param {string} mediaId
 * @returns {Promise<void>}
 */
export const deleteHlsOutputFromS3 = async (mediaId) => {
  const outputBucket = process.env.MEDIACONVERT_OUTPUT_BUCKET;
  if (!outputBucket) {
    console.warn("[deleteHlsOutputFromS3] MEDIACONVERT_OUTPUT_BUCKET is not set — skipping output cleanup");
    return;
  }

  const prefix = `videos/${mediaId}/`;
  let continuationToken;
  const objectsToDelete = [];

  // Paginate through all objects under the prefix
  do {
    let response;
    try {
      response = await awsS3Client.send(
        new ListObjectsV2Command({
          Bucket: outputBucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
    } catch (err) {
      console.error(`[deleteHlsOutputFromS3] Failed to list output bucket for mediaId ${mediaId}:`, err);
      return;
    }

    if (response.Contents) {
      for (const obj of response.Contents) {
        objectsToDelete.push({ Key: obj.Key });
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  if (objectsToDelete.length === 0) {
    return; // Nothing to delete — output not yet written, or already cleaned up
  }

  // Batch-delete in chunks of 1000 (S3 API limit)
  for (let i = 0; i < objectsToDelete.length; i += 1000) {
    const chunk = objectsToDelete.slice(i, i + 1000);
    try {
      await awsS3Client.send(
        new DeleteObjectsCommand({
          Bucket: outputBucket,
          Delete: { Objects: chunk, Quiet: true },
        })
      );
    } catch (err) {
      console.error(`[deleteHlsOutputFromS3] Failed to delete output chunk for mediaId ${mediaId}:`, err);
    }
  }

  console.log(`[deleteHlsOutputFromS3] Deleted ${objectsToDelete.length} output objects for mediaId ${mediaId}`);
};


