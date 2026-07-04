import mongoose from "mongoose";

const lessonProgressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      required: true,
    },

    section: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Section",
      required: true,
    },

    lesson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lesson",
      required: true,
    },

    enrollment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Enrollment",
      required: true,
    },

    duration: {
      type: Number,
      required: true,
      min: 0,
    },

    maxPositionReached: {
      type: Number,
      default: 0,
      min: 0,
    },

    lastPosition: {
      type: Number,
      default: 0,
      min: 0,
    },

    completed: {
      type: Boolean,
      default: false,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    lastWatchedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// One progress record per user per lesson
lessonProgressSchema.index({ user: 1, lesson: 1 }, { unique: true });

// Query all progress for a user in a specific course
lessonProgressSchema.index({ user: 1, course: 1 });

// Query all progress tied to an enrollment
lessonProgressSchema.index({ enrollment: 1 });

const LessonProgress = mongoose.model("LessonProgress", lessonProgressSchema);
export default LessonProgress;
