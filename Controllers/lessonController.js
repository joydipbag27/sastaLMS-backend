import Lesson from "../Models/lessonModel.js";
import Section from "../Models/sectionModel.js";
import Course from "../Models/courseModel.js";
import Media from "../Models/mediaModel.js";
import Enrollment from "../Models/enrollmentModel.js";
import { createLessonSchema, updateLessonSchema } from "../validators/lessonSchema.js";
import { successResponse, errorResponse } from "../utils/response.js";
import { deleteMediaFromStorage } from "../utils/deleteMediaUtil.js";

// CREATE LESSON
export const createLesson = async (req, res) => {
  const { success, data, error } = createLessonSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { title, description, course, section, isPreview, order, video } = data;

  try {
    const courseExists = await Course.findById(course);
    if (!courseExists) return errorResponse(res, 404, "Course not found");

    const sectionExists = await Section.findById(section);
    if (!sectionExists) return errorResponse(res, 404, "Section not found");

    if (sectionExists.course.toString() !== course) {
      return errorResponse(res, 400, "Section does not belong to the specified course");
    }

    if (req.user.role !== "ADMIN" && courseExists.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to modify this course");
    }

    if (video) {
      const media = await Media.findById(video);
      if (!media) return errorResponse(res, 404, "Media not found");
      if (media.status !== "READY") return errorResponse(res, 400, "Media is not ready");
    }

    const orderConflict = await Lesson.findOne({ section, order });
    if (orderConflict) return errorResponse(res, 409, `A lesson with order ${order} already exists in this section`);

    const newLesson = await Lesson.create({ title, description, course, section, isPreview, order, video });

    // Atomically increment the denormalized lesson counter on the course
    await Course.updateOne(
      { _id: course },
      { $inc: { "stats.lessonCount": 1 } }
    );

    return successResponse(res, 201, "Lesson created successfully", { lesson: newLesson });
  } catch (err) {
    console.error("[createLesson] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to create lesson");
  }
};

// GET LESSONS BY SECTION (access-controlled)
export const getLessonsBySection = async (req, res) => {
  try {
    const { sectionId } = req.params;

    const section = await Section.findById(sectionId);
    if (!section) return errorResponse(res, 404, "Section not found");

    const course = await Course.findById(section.course);
    if (!course) return errorResponse(res, 404, "Associated course not found");

    const user = req.user;
    const isCreator = user && (user.role === "ADMIN" || course.creator.toString() === user._id.toString());

    if (course.status !== "Published" && !isCreator) {
      return errorResponse(res, 403, "This course is not published");
    }

    const allLessons = await Lesson.find({ section: sectionId }).sort({ order: 1 }).populate("video").lean();

    if (isCreator) {
      return successResponse(res, 200, "Lessons fetched", { lessons: allLessons });
    }

    let isEnrolled = false;
    if (user && course.status === "Published") {
      const enrollment = await Enrollment.findOne({ user: user._id, course: course._id, status: "Active" });
      if (enrollment) {
        isEnrolled = true;
      }
    }

    const formattedLessons = allLessons.map((lesson) => {
      const hasMediaAccess = !!user && course.status === "Published" && (lesson.isPreview || isEnrolled);
      if (!hasMediaAccess) {
        const { video, ...rest } = lesson;
        return rest;
      }
      return lesson;
    });

    return successResponse(res, 200, "Lessons fetched", { lessons: formattedLessons });
  } catch (err) {
    console.error("[getLessonsBySection] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch lessons");
  }
};

// GET LESSON BY ID
export const getLessonById = async (req, res) => {
  try {
    // req.lesson is pre-fetched and access-validated by checkLessonAccess middleware
    return successResponse(res, 200, "Lesson fetched", { lesson: req.lesson });
  } catch (err) {
    console.error("[getLessonById] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch lesson");
  }
};

// UPDATE LESSON
export const updateLesson = async (req, res) => {
  try {
    const { id } = req.params;
    const { success, data, error } = updateLessonSchema.safeParse(req.body);
    if (!success) return errorResponse(res, 400, error.issues[0].message);

    const lesson = await Lesson.findById(id).populate("video");
    if (!lesson) return errorResponse(res, 404, "Lesson not found");

    const course = await Course.findById(lesson.course);
    if (!course) return errorResponse(res, 404, "Associated course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to modify this lesson");
    }

    if (data.order !== undefined && data.order !== lesson.order) {
      const orderConflict = await Lesson.findOne({ section: lesson.section, order: data.order });
      if (orderConflict) return errorResponse(res, 409, `A lesson with order ${data.order} already exists in this section`);
    }

    Object.assign(lesson, data);
    const updatedLesson = await lesson.save();
    return successResponse(res, 200, "Lesson updated successfully", { lesson: updatedLesson });
  } catch (err) {
    console.error("[updateLesson] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to update lesson");
  }
};

// DELETE LESSON
export const deleteLesson = async (req, res) => {
  try {
    const { id } = req.params;
    const lesson = await Lesson.findById(id);
    if (!lesson) return errorResponse(res, 404, "Lesson not found");

    const course = await Course.findById(lesson.course);
    if (!course) return errorResponse(res, 404, "Associated course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to delete this lesson");
    }

    // Delete associated Media from storage and MongoDB.
    // deleteMediaFromStorage correctly handles every pipeline state:
    // READY (B2), COPY_PENDING (B2 + S3 output), PROCESSING (S3 input + output), UPLOADING/FAILED (S3 input).
    if (lesson.video) {
      const media = await Media.findById(lesson.video);
      if (media) {
        await deleteMediaFromStorage(media);
        await media.deleteOne();
      }
    }

    await lesson.deleteOne();

    // Atomically decrement the denormalized lesson counter on the parent course.
    // lesson.course is available from the document fetched at the start of this handler.
    await Course.updateOne(
      { _id: lesson.course },
      { $inc: { "stats.lessonCount": -1 } }
    );

    return successResponse(res, 200, "Lesson deleted successfully");
  } catch (err) {
    console.error("[deleteLesson] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to delete lesson");
  }
};

// GET CREATOR'S OWN LESSONS BY SECTION
export const getMyLessonsBySection = async (req, res) => {
  try {
    const { sectionId } = req.params;
    const section = await Section.findById(sectionId);
    if (!section) return errorResponse(res, 404, "Section not found");

    const course = await Course.findById(section.course);
    if (!course) return errorResponse(res, 404, "Associated course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to view lessons for this section");
    }

    const lessons = await Lesson.find({ section: sectionId }).sort({ order: 1 }).populate("video");
    return successResponse(res, 200, "Lessons fetched", { lessons });
  } catch (err) {
    console.error("[getMyLessonsBySection] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch lessons");
  }
};

// GET CREATOR'S OWN LESSON BY ID
export const getMyLessonById = async (req, res) => {
  try {
    const { id } = req.params;
    const lesson = await Lesson.findById(id).populate("video");
    if (!lesson) return errorResponse(res, 404, "Lesson not found");

    const course = await Course.findById(lesson.course);
    if (!course) return errorResponse(res, 404, "Associated course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to view this lesson");
    }

    return successResponse(res, 200, "Lesson fetched", { lesson });
  } catch (err) {
    console.error("[getMyLessonById] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch lesson");
  }
};
