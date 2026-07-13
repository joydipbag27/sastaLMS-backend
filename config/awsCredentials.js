export const localAwsCredentials =
  process.env.LOCAL_AWS_ACCESS_KEY_ID &&
  process.env.LOCAL_AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.LOCAL_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.LOCAL_AWS_SECRET_ACCESS_KEY,
      }
    : undefined;
