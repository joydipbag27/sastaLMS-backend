import Section from "../Models/sectionModel.js";
import Course from "../Models/courseModel.js";
import Lesson from "../Models/lessonModel.js";
import Media from "../Models/mediaModel.js";
import { createSectionSchema, updateSectionSchema } from "../validators/sectionSchema.js";
import { successResponse, errorResponse } from "../utils/response.js";
import { permanentlyDeleteMultipleFromB2 } from "../config/s3Client.js";
import { deleteVideoFromS3 } from "../config/awsS3Client.js";

// CREATE SECTION
export const createSection = async (req, res) => {
  const { success, data, error } = createSectionSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { title, description, course, order } = data;

  try {
    const courseExists = await Course.findById(course);
    if (!courseExists) return errorResponse(res, 404, "Course not found");

    if (req.user.role !== "ADMIN" && courseExists.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to modify this course");
    }

    const orderConflict = await Section.findOne({ course, order });
    if (orderConflict) return errorResponse(res, 409, `A section with order ${order} already exists in this course`);

    const newSection = await Section.create({ title, description, course, order });
    return successResponse(res, 201, "Section created successfully", { section: newSection });
  } catch (err) {
    console.error("[createSection] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to create section");
  }
};

// GET SECTIONS BY COURSE
export const getSectionsByCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const course = await Course.findById(courseId);
    if (!course) return errorResponse(res, 404, "Course not found");

    const isCreator = req.user && (req.user.role === "ADMIN" || course.creator.toString() === req.user._id.toString());
    if (course.status !== "Published" && !isCreator) {
      return errorResponse(res, 403, "This course is not published");
    }

    const sections = await Section.find({ course: courseId }).sort({ order: 1 });
    return successResponse(res, 200, "Sections fetched", { sections });
  } catch (err) {
    console.error("[getSectionsByCourse] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch sections");
  }
};

// GET SECTION BY ID
export const getSectionById = async (req, res) => {
  try {
    const { id } = req.params;
    const section = await Section.findById(id);
    if (!section) return errorResponse(res, 404, "Section not found");

    const course = await Course.findById(section.course);
    if (!course) return errorResponse(res, 404, "Associated course not found");

    const isCreator = req.user && (req.user.role === "ADMIN" || course.creator.toString() === req.user._id.toString());
    if (course.status !== "Published" && !isCreator) {
      return errorResponse(res, 403, "This course is not published");
    }

    return successResponse(res, 200, "Section fetched", { section });
  } catch (err) {
    console.error("[getSectionById] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch section");
  }
};

// UPDATE SECTION
export const updateSection = async (req, res) => {
  try {
    const { id } = req.params;
    const { success, data, error } = updateSectionSchema.safeParse(req.body);
    if (!success) return errorResponse(res, 400, error.issues[0].message);

    const section = await Section.findById(id);
    if (!section) return errorResponse(res, 404, "Section not found");

    const course = await Course.findById(section.course);
    if (!course) return errorResponse(res, 404, "Associated course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to modify this section");
    }

    if (data.order !== undefined && data.order !== section.order) {
      const orderConflict = await Section.findOne({ course: section.course, order: data.order });
      if (orderConflict) return errorResponse(res, 409, `A section with order ${data.order} already exists in this course`);
    }

    Object.assign(section, data);
    const updatedSection = await section.save();
    return successResponse(res, 200, "Section updated successfully", { section: updatedSection });
  } catch (err) {
    console.error("[updateSection] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to update section");
  }
};

// DELETE SECTION (cascading)
export const deleteSection = async (req, res) => {
  try {
    const { id } = req.params;
    const section = await Section.findById(id);
    if (!section) return errorResponse(res, 404, "Section not found");

    const course = await Course.findById(section.course);
    if (!course) return errorResponse(res, 404, "Associated course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to delete this section");
    }

    // Cascade-delete associated Media from storage and MongoDB
    const lessons = await Lesson.find({ section: id }).select("video").lean();
    const mediaIds = lessons.map((l) => l.video).filter(Boolean);
    if (mediaIds.length > 0) {
      const medias = await Media.find({ _id: { $in: mediaIds } });
      const b2Keys = [];
      const s3Keys = [];
      for (const media of medias) {
        if (media.storageProvider === "AWS_S3" || media.status !== "READY") {
          s3Keys.push(media._id.toString());
        }
        if (media.storageProvider === "BACKBLAZE") {
          b2Keys.push(`videos/${media._id.toString()}/`);
        }
      }
      if (b2Keys.length > 0) {
        await permanentlyDeleteMultipleFromB2(b2Keys);
      }
      if (s3Keys.length > 0) {
        for (const key of s3Keys) {
          await deleteVideoFromS3(key);
        }
      }
      await Media.deleteMany({ _id: { $in: mediaIds } });
    }

    await Lesson.deleteMany({ section: id });
    await section.deleteOne();
    return successResponse(res, 200, "Section and all associated lessons deleted successfully");
  } catch (err) {
    console.error("[deleteSection] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to delete section");
  }
};

// GET CREATOR'S OWN SECTIONS BY COURSE
export const getMySectionsByCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const course = await Course.findById(courseId);
    if (!course) return errorResponse(res, 404, "Course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to view sections for this course");
    }

    const sections = await Section.find({ course: courseId }).sort({ order: 1 });
    return successResponse(res, 200, "Sections fetched", { sections });
  } catch (err) {
    console.error("[getMySectionsByCourse] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch sections");
  }
};

// GET CREATOR'S OWN SECTION BY ID
export const getMySectionById = async (req, res) => {
  try {
    const { id } = req.params;
    const section = await Section.findById(id);
    if (!section) return errorResponse(res, 404, "Section not found");

    const course = await Course.findById(section.course);
    if (!course) return errorResponse(res, 404, "Associated course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to view this section");
    }

    return successResponse(res, 200, "Section fetched", { section });
  } catch (err) {
    console.error("[getMySectionById] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch section");
  }
};
