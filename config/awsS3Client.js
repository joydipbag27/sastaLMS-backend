import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
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
  const uploadUrl = await getSignedUrl(awsS3Client, command, { expiresIn: 3600 });
  return { uploadUrl, objectKey };
};

export const deleteThumbnailFromS3 = async (mediaId) => {
  const objectKey = `course-thumbnails/${mediaId}`;
  try {
    await awsS3Client.send(
      new DeleteObjectCommand({
        Bucket: process.env.AWS_THUMBNAIL_BUCKET,
        Key: objectKey,
      })
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
