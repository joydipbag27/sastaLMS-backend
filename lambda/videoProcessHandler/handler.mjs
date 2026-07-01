
export const handler = async (event) => {
  try {
    const payload = {
      mediaId: event.detail.userMetadata?.mediaId,
      jobId: event.detail.jobId,
      status: event.detail.status,
      timestamp: event.detail.timestamp,
      warnings: event.detail.warnings ?? [],
      errorMessage: event.detail.errorMessage ?? null,
    };

    if (!payload.mediaId) {
      throw new Error("MediaId missing.");
    }

    const response = await fetch(
      `${process.env.BACKEND_URL}/media/internal/processing-complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-veolms-secret": process.env.LAMBDA_SECRET,
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    return {
      statusCode: 200,
    };
  } catch (err) {
    console.error(err);

    return {
      statusCode: 500,
    };
  }
};

//handler.handler in lambda
//env in lambda LAMBDA_SECRET, BACKEND_URL
