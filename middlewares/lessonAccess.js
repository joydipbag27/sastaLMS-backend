import Lesson from "../Models/lessonModel.js";
import Course from "../Models/courseModel.js";
import Enrollment from "../Models/enrollmentModel.js";

export const checkLessonAccess = async (req, res, next) => {
  try {
    // 1. Strict Authentication
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized. Please log in." });
    }

    const { id: lessonId } = req.params;

    // 2. Fetch the lesson
    const lesson = await Lesson.findById(lessonId).populate("video");
    if (!lesson) {
      return res.status(404).json({ error: "Lesson not found" });
    }

    // 3. Admin access
    if (req.user.role === "ADMIN") {
      req.lesson = lesson; // Attach for convenience
      return next();
    }

    // 4. Fetch the course
    const course = await Course.findById(lesson.course);
    if (!course) {
      return res.status(404).json({ error: "Associated course not found" });
    }

    // 5. Creator access
    if (course.creator.toString() === req.user._id.toString()) {
      req.lesson = lesson;
      return next();
    }

    // Restrict access to unpublished course lessons for students
    if (course.status !== "Published") {
      return res.status(403).json({ error: "This course is not published" });
    }

    // 6. Preview access
    if (lesson.isPreview) {
      req.lesson = lesson;
      return next();
    }

    // 7. Enrollment access
    const enrollment = await Enrollment.findOne({
      user: req.user._id,
      course: course._id,
      status: "Active", // Ensure the enrollment is active
    });

    if (enrollment) {
      req.lesson = lesson;
      return next();
    }

    // 8. If none matched, reject
    return res.status(403).json({ error: "You do not have access to this lesson" });
  } catch (err) {
    next(err);
  }
};
