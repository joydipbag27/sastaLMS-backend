import { S3Client } from "@aws-sdk/client-s3";
import {
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

export const permanentlyDeleteMultipleFromB2 = async (keys) => {
  const objectsToDelete = [];

  for (const key of keys) {
    const versionsData = await s3Client.send(
      new ListObjectVersionsCommand({
        Bucket: process.env.BUCKET_NAME,
        Prefix: key,
      }),
    );

    if (versionsData.Versions) {
      for (const version of versionsData.Versions) {
        objectsToDelete.push({
          Key: key,
          VersionId: version.VersionId,
        });
      }
    }

    if (versionsData.DeleteMarkers) {
      for (const marker of versionsData.DeleteMarkers) {
        objectsToDelete.push({
          Key: key,
          VersionId: marker.VersionId,
        });
      }
    }
  }

  if (objectsToDelete.length === 0) return;

  await s3Client.send(
    new DeleteObjectsCommand({
      Bucket: process.env.BUCKET_NAME,
      Delete: {
        Objects: objectsToDelete,
        Quiet: true,
      },
    }),
  );
};
