import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client } from "../config/s3Client.js";

export const getUploadUrl = async (req, res, next) => {
  const { fileName, contentType } = req.body;

  if (!fileName || !contentType) {
    return res
      .status(400)
      .json({ error: "fileName and contentType are required" });
  }

  try {
    const command = new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: fileName,
      ContentType: contentType,
    });

    const url = await getSignedUrl(s3Client, command, {
      expiresIn: 3600, // 1 hour
    });

    return res.status(200).json({ uploadUrl: url, key: fileName });
  } catch (error) {
    console.error("Error generating presigned PUT URL", error);
    next(error);
  }
};

export const getDownloadUrl = async (req, res, next) => {
  const { key } = req.params;

  if (!key) {
    return res.status(400).json({ error: "File key is required" });
  }

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: key,
    });

    const url = await getSignedUrl(s3Client, command, {
      expiresIn: 3600, // 1 hour
    });

    return res.status(200).json({ downloadUrl: url });
  } catch (error) {
    console.error("Error generating presigned GET URL", error);
    next(error);
  }
};
