import { ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { awsS3Client } from "../config/awsS3Client.js";

/**
 * Parses HLS playlist content and calculates the sum of all segment durations.
 *
 * @param {string} playlistContent - The raw text content of the .m3u8 playlist file.
 * @returns {number} The total duration in seconds.
 */
export const parsePlaylistDuration = (playlistContent) => {
  let totalDuration = 0;
  if (!playlistContent) return totalDuration;

  const lines = playlistContent.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase().startsWith("#EXTINF:")) {
      // Format is: #EXTINF:<duration>,[title]
      // Split by comma first to isolate the duration part
      const durationPart = trimmed.slice(8).split(",")[0].trim();
      const duration = parseFloat(durationPart);
      if (!isNaN(duration)) {
        totalDuration += duration;
      }
    }
  }
  return totalDuration;
};

/**
 * Automatically determines and calculates the duration of a processed HLS video
 * by fetching and parsing one of its resolution-specific media playlists on S3.
 *
 * @param {string} mediaId - The ID of the media.
 * @returns {Promise<number>} The total duration rounded to 2 decimal places.
 */
export const calculateHlsDurationFromS3 = async (mediaId) => {
  const bucket = process.env.MEDIACONVERT_OUTPUT_BUCKET;
  if (!bucket) {
    throw new Error("MEDIACONVERT_OUTPUT_BUCKET environment variable is not defined");
  }

  const prefix = `videos/${mediaId}/`;
  
  // 1. List objects under videos/<mediaId>/ to find a media playlist
  let response;
  try {
    response = await awsS3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
      })
    );
  } catch (err) {
    console.error(`[durationService] Failed to list S3 objects for mediaId ${mediaId}:`, err);
    throw new Error(`Failed to list objects in output bucket: ${err.message}`);
  }

  if (!response.Contents || response.Contents.length === 0) {
    throw new Error(`No files found in output bucket under prefix: ${prefix}`);
  }

  // 2. Identify the media playlist (ends with .m3u8, is not the master playlist)
  const masterPlaylistKey = `${prefix}${mediaId}.m3u8`;
  const mediaPlaylistObj = response.Contents.find(
    (obj) => obj.Key.endsWith(".m3u8") && obj.Key !== masterPlaylistKey
  );

  if (!mediaPlaylistObj) {
    throw new Error(`Could not find a media playlist (non-master .m3u8) for mediaId: ${mediaId}`);
  }

  const playlistKey = mediaPlaylistObj.Key;
  console.log(`[durationService] Found media playlist for duration parsing: ${playlistKey}`);

  // 3. Fetch the playlist file content from S3
  let getObjectResponse;
  try {
    getObjectResponse = await awsS3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: playlistKey,
      })
    );
  } catch (err) {
    console.error(`[durationService] Failed to fetch playlist ${playlistKey} from S3:`, err);
    throw new Error(`Failed to fetch media playlist from S3: ${err.message}`);
  }

  // 4. Read the file body stream into a string
  let content = "";
  try {
    if (getObjectResponse.Body) {
      if (typeof getObjectResponse.Body.transformToString === "function") {
        content = await getObjectResponse.Body.transformToString("utf-8");
      } else {
        const chunks = [];
        for await (const chunk of getObjectResponse.Body) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        content = Buffer.concat(chunks).toString("utf-8");
      }
    }
  } catch (err) {
    console.error(`[durationService] Failed to parse stream for playlist ${playlistKey}:`, err);
    throw new Error(`Failed to read media playlist content: ${err.message}`);
  }

  if (!content) {
    throw new Error(`Media playlist ${playlistKey} is empty`);
  }

  // 5. Parse and sum EXTINF values
  const totalDuration = parsePlaylistDuration(content);
  
  // Round to 2 decimal places (appropriate floating point precision)
  const roundedDuration = Math.round(totalDuration * 100) / 100;
  console.log(`[durationService] Calculated duration for mediaId ${mediaId}: ${roundedDuration}s`);
  
  return roundedDuration;
};
