import mongoose from "mongoose";

const mediaSchema = new mongoose.Schema(
  {
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },


    mimeType: {
      type: String,
      required: true,
    },

    size: {
      type: Number,
      required: true,
    },

    status: {
      type: String,
      enum: ["UPLOADING", "PROCESSING", "READY", "FAILED", "COPY_PENDING"],
      default: "UPLOADING",
    },

    // Set when status is COPY_PENDING — absolute path to the failed-upload.log file
    failedUploadLog: {
      type: String,
      default: null,
    },

    // Number of rclone pipeline runs attempted (for diagnostics and auditing)
    copyAttempts: {
      type: Number,
      default: 0,
    },

    type: {
      type: String,
      enum: ["VIDEO", "THUMBNAIL"],
      default: "VIDEO",
      required: true,
    },

    storageProvider: {
      type: String,
      enum: ["BACKBLAZE", "AWS_S3"],
      default: "BACKBLAZE",
      required: true,
    },

    jobId: {
      type: String,
    },

    error: {
      type: String,
    },

    duration: {
      type: Number,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const Media = mongoose.model("Media", mediaSchema);
export default Media;
