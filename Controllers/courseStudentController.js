import Course from "../Models/courseModel.js";
import Section from "../Models/sectionModel.js";
import Lesson from "../Models/lessonModel.js";
import { successResponse, errorResponse } from "../utils/response.js";

// GET ALL COURSES (paginated, published only)
export const getCourses = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const cursor = req.query.cursor;

    const query = { status: "Published" };
    if (cursor) query._id = { $lt: cursor };

    const courses = await Course.find(query).populate("thumbnail").sort({ _id: -1 }).limit(limit + 1);
    const hasNextPage = courses.length > limit;
    const data = hasNextPage ? courses.slice(0, limit) : courses;
    const nextCursor = hasNextPage ? data[data.length - 1]._id : null;

    return successResponse(res, 200, "Courses fetched", { courses: data, nextCursor, hasNextPage });
  } catch (err) {
    console.error("[getCourses] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch courses");
  }
};

// GET COURSE BY ID
export const getCourseById = async (req, res) => {
  try {
    const { id } = req.params;
    const course = await Course.findById(id).populate("creator", "username email").populate("thumbnail").populate("trailer");
    if (!course) return errorResponse(res, 404, "Course not found");

    const isCreator = req.user && (req.user.role === "ADMIN" || course.creator._id.toString() === req.user._id.toString());
    if (course.status !== "Published" && !isCreator) {
      return errorResponse(res, 403, "This course is not published");
    }

    return successResponse(res, 200, "Course fetched", { course });
  } catch (err) {
    console.error("[getCourseById] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch course");
  }
};

// GET COURSE DETAILS (course + sections + lessons structured)
export const getCourseDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const course = await Course.findById(id).populate("creator", "username email").populate("thumbnail").populate("trailer");
    if (!course) return errorResponse(res, 404, "Course not found");

    const sections = await Section.find({ course: id }).sort({ order: 1 }).lean();
    const lessons = await Lesson.find({ course: id }).sort({ order: 1 }).populate("video").lean();

    const isCreator = req.user && (req.user.role === "ADMIN" || course.creator._id.toString() === req.user._id.toString());
    if (course.status !== "Published" && !isCreator) {
      return errorResponse(res, 403, "This course is not published");
    }

    let isEnrolled = false;
    if (req.user && course.status === "Published") {
      const enrollment = await Enrollment.findOne({ user: req.user._id, course: course._id, status: "Active" });
      if (enrollment) {
        isEnrolled = true;
      }
    }

    const lessonsBySection = {};
    for (const lesson of lessons) {
      const hasMediaAccess = isCreator || (!!req.user && course.status === "Published" && (lesson.isPreview || isEnrolled));
      let finalLesson;
      if (hasMediaAccess) {
        finalLesson = lesson;
      } else {
        const { video, ...safeLesson } = lesson;
        finalLesson = safeLesson;
      }
      const secId = finalLesson.section.toString();
      if (!lessonsBySection[secId]) lessonsBySection[secId] = [];
      lessonsBySection[secId].push(finalLesson);
    }

    const formattedSections = sections.map((sec) => ({
      section: sec,
      lessons: lessonsBySection[sec._id.toString()] || [],
    }));

    return successResponse(res, 200, "Course details fetched", { course, sections: formattedSections });
  } catch (err) {
    console.error("[getCourseDetails] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch course details");
  }
};
