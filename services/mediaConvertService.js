import {
  MediaConvertClient,
  CreateJobCommand,
  DescribeEndpointsCommand,
} from "@aws-sdk/client-mediaconvert";
import { jobTemplate } from "./jobTemplate.js";

export const mediaConvertClient = new MediaConvertClient({
  region: process.env.AWS_REGION,
  endpoint: process.env.MEDIACONVERT_ENDPOINT,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});



/**
 * Creates a MediaConvert transcoding job based on the jobTemplate.
 * Replaces the FileInput, Destination, and Role dynamically.
 *
 * @param {Object} params
 * @param {string} params.mediaId
 * @returns {Promise<string>} The MediaConvert Job ID
 */

export const createJob = async ({ mediaId }) => {

  const jobConfig = structuredClone(jobTemplate);

  const fileInput = `s3://${process.env.MEDIACONVERT_INPUT_BUCKET}/${mediaId}`;
  const destination = `s3://${process.env.MEDIACONVERT_OUTPUT_BUCKET}/videos/${mediaId}/`;

  // Apply dynamic values
  jobConfig.Settings.Inputs[0].FileInput = fileInput;
  jobConfig.Settings.OutputGroups[0].OutputGroupSettings.HlsGroupSettings.Destination =
    destination;
  jobConfig.Role = process.env.MEDIACONVERT_ROLE;
  jobConfig.Queue = process.env.MEDIACONVERT_QUEUE;
  jobConfig.UserMetadata.mediaId = mediaId;

  const command = new CreateJobCommand(jobConfig);
  try {
    const response = await mediaConvertClient.send(command);

    if (!response.Job?.Id) {
      throw new Error("MediaConvert job was created without a Job ID.");
    }

    return response.Job.Id;
  } catch (error) {
    console.error("MediaConvert job creation failed:", {
      name: error.name,
      message: error.message,
      metadata: error.$metadata,
    });
    throw error;
  }
};
