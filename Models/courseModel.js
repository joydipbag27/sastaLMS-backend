import mongoose from "mongoose";

const courseSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      required: true,
      trim: true,
    },

    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    thumbnail: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Media",
    },

    price: {
      type: Number,
      default: 0,
    },

    category: {
      type: String,
      required: true,
    },

    level: {
      type: String,
      enum: ["Beginner", "Intermediate", "Advanced"],
      default: "Beginner",
    },

    status: {
      type: String,
      enum: ["Draft", "Published"],
      default: "Draft",
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

courseSchema.virtual("thumbnailUrl").get(function () {
  if (!this.thumbnail) return undefined;
  const mediaId = this.thumbnail._id ? this.thumbnail._id.toString() : this.thumbnail.toString();
  return `https://${process.env.AWS_THUMBNAIL_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/course-thumbnails/${mediaId}`;
});

const Course = mongoose.model("Course", courseSchema);
export default Course;
