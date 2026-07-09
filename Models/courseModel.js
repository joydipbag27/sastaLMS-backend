import mongoose from "mongoose";

const courseSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    displayName: {
      type: String,
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

    trailer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Media",
    },

    price: {
      type: Number,
      default: 0,
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

    stats: {
      sectionCount: {
        type: Number,
        default: 0,
        min: 0,
      },
      lessonCount: {
        type: Number,
        default: 0,
        min: 0,
      },
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

courseSchema.virtual("trailerUrl").get(function () {
  if (!this.trailer) return undefined;
  const mediaId = this.trailer._id ? this.trailer._id.toString() : this.trailer.toString();
  return `https://${process.env.AWS_THUMBNAIL_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/course-trailers/${mediaId}`;
});

const Course = mongoose.model("Course", courseSchema);
export default Course;
