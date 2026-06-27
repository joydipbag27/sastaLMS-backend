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
      enum: ["UPLOADING", "READY", "FAILED"],
      default: "UPLOADING",
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
  },
  {
    timestamps: true,
  }
);

const Media = mongoose.model("Media", mediaSchema);
export default Media;
