import * as z from "zod/v4";

export const createOrderSchema = z.object({
  courseId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid course ID"),
});
