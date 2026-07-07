import Course from "../Models/courseModel.js";
import Section from "../Models/sectionModel.js";
import Lesson from "../Models/lessonModel.js";
import Media from "../Models/mediaModel.js";
import {
  createCourseSchema,
  updateCourseSchema,
  thumbnailUploadUrlSchema,
  confirmThumbnailSchema,
} from "../validators/courseSchema.js";
import { successResponse, errorResponse } from "../utils/response.js";
import { permanentlyDeleteMultipleFromB2 } from "../config/s3Client.js";
import {
  generateThumbnailUploadUrl,
  deleteThumbnailFromS3,
  getThumbnailMetadata,
  deleteVideoFromS3,
} from "../config/awsS3Client.js";

// CREATE COURSE
export const createCourse = async (req, res) => {
  const { success, data, error } = createCourseSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { title, description, price, level, status } = data;
  try {
    const newCourse = await Course.create({
      title, description,
      creator: req.user._id,
      price, level,
      status: "Draft",
    });

    return successResponse(res, 201, "Course created successfully", { course: newCourse });
  } catch (err) {
    console.error("[createCourse] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to create course");
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

    const courses = await Course.find(query).populate("thumbnail").sort({ _id: -1 }).limit(limit + 1);
    const hasNextPage = courses.length > limit;
    const data = hasNextPage ? courses.slice(0, limit) : courses;
    const nextCursor = hasNextPage ? data[data.length - 1]._id : null;

    return successResponse(res, 200, "Courses fetched", { courses: data, nextCursor, hasNextPage });
  } catch (err) {
    console.error("[getMyCourses] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to fetch courses");
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

// PUBLISH COURSE
export const publishCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const course = await Course.findById(id);
    if (!course) return errorResponse(res, 404, "Course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to publish this course");
    }

    if (course.status === "Published") {
      return errorResponse(res, 400, "Course is already published");
    }

    // Check: at least one section
    const sections = await Section.find({ course: id }).lean();
    if (sections.length === 0) {
      return errorResponse(res, 400, "Course must have at least one section to be published");
    }

    // Check: every section must have at least one lesson
    const sectionIds = sections.map((s) => s._id);
    const lessons = await Lesson.find({ section: { $in: sectionIds } }).lean();

    const sectionsWithLessons = new Set(lessons.map((l) => l.section.toString()));
    for (const section of sections) {
      if (!sectionsWithLessons.has(section._id.toString())) {
        return errorResponse(
          res,
          400,
          `Every section must have at least one lesson. Section "${section.title}" is empty.`
        );
      }
    }

    // Check: every lesson must have a video attached
    const lessonsWithoutVideo = lessons.filter((l) => !l.video);
    if (lessonsWithoutVideo.length > 0) {
      return errorResponse(
        res,
        400,
        `Every lesson must have a video attached. ${lessonsWithoutVideo.length} lesson(s) are missing videos.`
      );
    }

    course.status = "Published";
    await course.save();
    return successResponse(res, 200, "Course published successfully", { course });
  } catch (err) {
    console.error("[publishCourse] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to publish course");
  }
};

// UNPUBLISH COURSE
export const unpublishCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const course = await Course.findById(id);
    if (!course) return errorResponse(res, 404, "Course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to unpublish this course");
    }

    if (course.status === "Draft") {
      return errorResponse(res, 400, "Course is already in draft state");
    }

    course.status = "Draft";
    await course.save();
    return successResponse(res, 200, "Course unpublished successfully", { course });
  } catch (err) {
    console.error("[unpublishCourse] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to unpublish course");
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

    // Cascade-delete associated thumbnail (if any) from S3 and MongoDB
    if (course.thumbnail) {
      await deleteThumbnailFromS3(course.thumbnail.toString());
      await Media.findByIdAndDelete(course.thumbnail);
    }

    // Cascade-delete associated Media (videos) from storage and MongoDB
    const lessons = await Lesson.find({ course: id }).select("video").lean();
    const mediaIds = lessons.map((l) => l.video).filter(Boolean);
    if (mediaIds.length > 0) {
      const medias = await Media.find({ _id: { $in: mediaIds } });
      const b2Keys = [];
      const s3Keys = [];
      for (const media of medias) {
        if (media.storageProvider === "AWS_S3") {
          s3Keys.push(media._id.toString());
        } else {
          b2Keys.push(media._id.toString());
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

    await Lesson.deleteMany({ course: id });
    await Section.deleteMany({ course: id });
    await course.deleteOne();

    return successResponse(res, 200, "Course and all associated data deleted successfully");
  } catch (err) {
    console.error("[deleteCourse] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to delete course");
  }
};

// GET THUMBNAIL UPLOAD URL
export const getThumbnailUploadUrl = async (req, res) => {
  const { id } = req.params;
  const { success, data, error } = thumbnailUploadUrlSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { mimeType } = data;

  try {
    const course = await Course.findById(id);
    if (!course) return errorResponse(res, 404, "Course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to modify this course");
    }

    // Create a Media document in DB with UPLOADING status, type THUMBNAIL, storageProvider AWS_S3
    const media = await Media.create({
      uploadedBy: req.user._id,
      mimeType,
      size: 0,
      status: "UPLOADING",
      type: "THUMBNAIL",
      storageProvider: "AWS_S3",
    });

    const mediaId = media._id.toString();

    // Generate AWS S3 presigned PUT URL using the mediaId as key
    const { uploadUrl } = await generateThumbnailUploadUrl(mediaId, mimeType);

    return successResponse(res, 200, "Upload URL generated successfully", {
      uploadUrl,
      mediaId,
    });
  } catch (err) {
    console.error("[getThumbnailUploadUrl] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to generate upload URL");
  }
};

// CONFIRM THUMBNAIL
export const confirmThumbnail = async (req, res) => {
  const { id } = req.params;
  const { success, data, error } = confirmThumbnailSchema.safeParse(req.body);
  if (!success) return errorResponse(res, 400, error.issues[0].message);

  const { mediaId } = data;

  try {
    const course = await Course.findById(id);
    if (!course) return errorResponse(res, 404, "Course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to modify this course");
    }

    const media = await Media.findById(mediaId);
    if (!media) return errorResponse(res, 404, "Media document not found");

    if (media.uploadedBy.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to confirm this media");
    }

    if (media.status !== "UPLOADING") {
      return errorResponse(res, 400, "Media is not in UPLOADING status");
    }

    // Call S3 to check object existence and properties
    let metadata;
    try {
      metadata = await getThumbnailMetadata(mediaId);
    } catch (err) {
      console.error("[confirmThumbnail] File lookup failed on S3. Cleaning up:", err);
      await deleteThumbnailFromS3(mediaId);
      await media.deleteOne();
      return errorResponse(res, 400, "File does not exist on storage");
    }

    // Verify size limit: 2 MB maximum
    const maxLimit = 2 * 1024 * 1024;
    if (metadata.contentLength > maxLimit) {
      console.error(`[confirmThumbnail] Size limit exceeded: ${metadata.contentLength} bytes`);
      await deleteThumbnailFromS3(mediaId);
      await media.deleteOne();
      return errorResponse(res, 400, "File size exceeds the 2 MB maximum limit");
    }

    // Verify contentType is allowed
    const allowedMimeTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!allowedMimeTypes.includes(metadata.contentType)) {
      console.error(`[confirmThumbnail] Mime type not allowed: ${metadata.contentType}`);
      await deleteThumbnailFromS3(mediaId);
      await media.deleteOne();
      return errorResponse(res, 400, "Invalid image format on storage");
    }

    // Update Media fields
    media.size = metadata.contentLength;
    media.mimeType = metadata.contentType;
    media.status = "READY";
    await media.save();

    // Associate media with course & clean up old media/S3 object if replacement occurs
    const previousThumbnailId = course.thumbnail;
    course.thumbnail = media._id;
    await course.save();

    if (previousThumbnailId && previousThumbnailId.toString() !== media._id.toString()) {
      const oldMedia = await Media.findById(previousThumbnailId);
      if (oldMedia) {
        await deleteThumbnailFromS3(previousThumbnailId.toString());
        await oldMedia.deleteOne();
      }
    }

    const updatedCourse = await Course.findById(id).populate("thumbnail").populate("creator", "username email");
    return successResponse(res, 200, "Thumbnail upload confirmed successfully", { course: updatedCourse });
  } catch (err) {
    console.error("[confirmThumbnail] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to confirm thumbnail upload");
  }
};

// DELETE THUMBNAIL
export const deleteThumbnail = async (req, res) => {
  const { id } = req.params;

  try {
    const course = await Course.findById(id);
    if (!course) return errorResponse(res, 404, "Course not found");

    if (req.user.role !== "ADMIN" && course.creator.toString() !== req.user._id.toString()) {
      return errorResponse(res, 403, "You do not have permission to delete this thumbnail");
    }

    const thumbnailId = course.thumbnail;
    if (!thumbnailId) {
      return successResponse(res, 200, "Course has no thumbnail to delete");
    }

    // Delete S3 object
    await deleteThumbnailFromS3(thumbnailId.toString());

    // Delete Media document
    await Media.findByIdAndDelete(thumbnailId);

    // Set course.thumbnail = null
    course.thumbnail = null;
    await course.save();

    return successResponse(res, 200, "Thumbnail deleted successfully");
  } catch (err) {
    console.error("[deleteThumbnail] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to delete thumbnail");
  }
};
