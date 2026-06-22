import mongoose from "mongoose";
import Notification from "../Models/notificationModel.js";

//GET NOTIFICATION (LIMITED)
export const getNotification = async (req, res) => {
  try {
    const notification = await Notification.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50);
    return res.status(200).json(notification);
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch notifications" });
  }
};

//GET UNREAD COUNT
export const getUnreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      userId: req.user._id,
      isRead: false,
    });

    return res.status(200).json({ unreadCount: count });
  } catch (error) {
    return res.status(500).json({ error: "Failed to get unread count" });
  }
};

//MARK AS READ
export const markAsRead = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: "Invalid file Id" });
  }
  try {
    await Notification.findOneAndUpdate(
      {
        _id: id,
        userId: req.user._id,
        isRead: false,
      },
      { isRead: true },
    );
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Failed to read notification" });
  }
};

//MARK ALL AS READ
export const markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      {
        userId: req.user._id,
        isRead: false,
      },
      { isRead: true },
    );
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Failed to read notification" });
  }
};

//CLEAR ALL NOTIFICATIONS
export const clearAllNotification = async (req, res) => {
  try {
    await Notification.deleteMany({ userId: req.user._id });

    res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Failed to clear notifications" });
  }
};
