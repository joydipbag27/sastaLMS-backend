import Notification from "../Models/notificationModel.js";

export const createNotification = async ({
  userId,
  type,
  title,
  message,
  metadata = {},
  group = false,
  incrementBy = 1,
}) => {
  if (group) {
    const since = new Date(Date.now() - 15 * 60 * 1000);

    return Notification.findOneAndUpdate(
      {
        userId,
        type,
        isRead: false,
        createdAt: { $gte: since },
      },
      {
        $inc: { count: incrementBy },
        $setOnInsert: {
          title,
          message,
          metadata,
        },
      },
      {
        upsert: true,
        new: true,
      },
    );
  }

  return Notification.create({
    userId,
    type,
    title,
    message,
    metadata,
    count: incrementBy,
  });
};
