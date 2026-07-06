import * as z from "zod/v4";

export const createLessonSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, "Title must be at least 3 characters")
    .max(100, "Title cannot exceed 100 characters"),
  description: z
    .string()
    .trim()
    .optional()
    .default(""),
  course: z
    .string()
    .regex(/^[a-f\d]{24}$/i, "Invalid course ID"),
  section: z
    .string()
    .regex(/^[a-f\d]{24}$/i, "Invalid section ID"),
  isPreview: z
    .boolean()
    .default(false),
  order: z.coerce
    .number()
    .int("Order must be an integer")
    .positive("Order must be positive")
    .default(1),
});

export const updateLessonSchema = createLessonSchema.omit({ course: true, section: true }).partial();

