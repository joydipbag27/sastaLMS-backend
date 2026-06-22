import mongoose from "mongoose";
import { NOTIFICATION_TYPES } from "../config/notificationTypes.js";

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    type: {
      type: String,
      enum: Object.values(NOTIFICATION_TYPES),
      required: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
    },

    message: {
      type: String,
      required: true,
      trim: true,
    },

    metadata: {
      fileId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "File",
      },
      folderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Folder",
      },
      sharedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
      token: {
        type: String,
      },
    },

    count: {
      type: Number,
      default: 1,
    },

    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

const Notification = mongoose.model("Notification", notificationSchema);
export default Notification;
