import Course from "../Models/courseModel.js";
import Section from "../Models/sectionModel.js";
import Lesson from "../Models/lessonModel.js";
import Media from "../Models/mediaModel.js";
import { createCourseSchema, updateCourseSchema } from "../validators/courseSchema.js";
import { successResponse, errorResponse } from "../utils/response.js";
import { permanentlyDeleteMultipleFromB2 } from "../config/s3Client.js";

// CREATE COURSE
export const createCourse = async (req, res) => {
  const { success, data, error } = createCourseSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { title, description, thumbnail, price, category, level, status } = data;

  try {
    const newCourse = await Course.create({
      title, description, thumbnail,
      creator: req.user._id,
      price, category, level, status,
    });

    return successResponse(res, 201, "Course created successfully", { course: newCourse });
  } catch (err) {
    console.error("[createCourse] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to create course");
  }
};

// GET ALL COURSES (paginated)
export const getCourses = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const cursor = req.query.cursor;
    const category = req.query.category;
    const level = req.query.level;
    const status = req.query.status || "Published";

    const query = { status };
    if (category) query.category = category;
    if (level) query.level = level;
    if (cursor) query._id = { $lt: cursor };

    const courses = await Course.find(query).sort({ _id: -1 }).limit(limit + 1);
    const hasNextPage = courses.length > limit;
    const data = hasNextPage ? courses.slice(0, limit) : courses;
    const nextCursor = hasNextPage ? data[data.length - 1]._id : null;

    return successResponse(res, 200, "Courses fetched", { courses: data, nextCursor, hasNextPage });
  } catch (err) {
    console.error("[getCourses] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch courses");
  }
};

// GET CREATOR'S OWN COURSES
export const getMyCourses = async (req, res) => {
  try {
    const creatorId = req.user._id;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const cursor = req.query.cursor;

    const query = { creator: creatorId };
    if (req.query.status && req.query.status !== "All") {
      query.status = req.query.status;
    }
    if (cursor) query._id = { $lt: cursor };

    const courses = await Course.find(query).sort({ _id: -1 }).limit(limit + 1);
    const hasNextPage = courses.length > limit;
    const data = hasNextPage ? courses.slice(0, limit) : courses;
    const nextCursor = hasNextPage ? data[data.length - 1]._id : null;

    return successResponse(res, 200, "Courses fetched", { courses: data, nextCursor, hasNextPage });
  } catch (err) {
    console.error("[getMyCourses] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch courses");
  }
};

// GET COURSE BY ID
export const getCourseById = async (req, res) => {
  try {
    const { id } = req.params;
    const course = await Course.findById(id).populate("creator", "username email");
    if (!course) return errorResponse(res, 404, "Course not found");
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

    const course = await Course.findById(id).populate("creator", "username email");
    if (!course) return errorResponse(res, 404, "Course not found");

    const sections = await Section.find({ course: id }).sort({ order: 1 }).lean();
    const lessons = await Lesson.find({ course: id }).sort({ order: 1 }).populate("video").lean();

    const lessonsBySection = {};
    for (const lesson of lessons) {
      const { video, ...safeLesson } = lesson;
      const secId = safeLesson.section.toString();
      if (!lessonsBySection[secId]) lessonsBySection[secId] = [];
      lessonsBySection[secId].push(safeLesson);
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

// UPDATE COURSE
export const updateCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const { success, data, error } = updateCourseSchema.safeParse(req.body);
    if (!success) return errorResponse(res, 400, error.issues[0].message);

    const course = await Course.findById(id);
    if (!course) return errorResponse(res, 404, "Course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to update this course");
    }

    Object.assign(course, data);
    const updatedCourse = await course.save();
    return successResponse(res, 200, "Course updated successfully", { course: updatedCourse });
  } catch (err) {
    console.error("[updateCourse] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to update course");
  }
};

// DELETE COURSE (cascading)
export const deleteCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const course = await Course.findById(id);
    if (!course) return errorResponse(res, 404, "Course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to delete this course");
    }

    // Cascade-delete associated Media from B2 and MongoDB
    const lessons = await Lesson.find({ course: id }).select("video").lean();
    const mediaIds = lessons.map((l) => l.video).filter(Boolean);
    if (mediaIds.length > 0) {
      const mediaRecords = await Media.find({ _id: { $in: mediaIds } }).lean();
      const storageKeys = mediaRecords.map((m) => m.storageKey);
      if (storageKeys.length > 0) await permanentlyDeleteMultipleFromB2(storageKeys);
      await Media.deleteMany({ _id: { $in: mediaIds } });
    }

    await Lesson.deleteMany({ course: id });
    await Section.deleteMany({ course: id });
    await course.deleteOne();

    return successResponse(res, 200, "Course and all associated data deleted successfully");
  } catch (err) {
    console.error("[deleteCourse] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to delete course");
  }
};
