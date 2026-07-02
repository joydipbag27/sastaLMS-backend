import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
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
