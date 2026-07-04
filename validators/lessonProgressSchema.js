import * as z from "zod/v4";

export const updateLessonProgressSchema = z.object({
  lastPosition: z.coerce
    .number()
    .nonnegative("lastPosition must be a non-negative number"),
});
