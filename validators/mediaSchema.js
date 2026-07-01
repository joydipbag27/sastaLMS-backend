import * as z from "zod/v4";

export const uploadUrlSchema = z.object({
  mimeType: z
    .string()
    .trim()
    .min(1, "mimeType is required")
    .regex(/^video\//, "Only video uploads are allowed"),
});

export const confirmUploadSchema = z.object({
  mediaId: z
    .string()
    .regex(/^[a-f\d]{24}$/i, "Invalid media ID"),
  mimeType: z
    .string()
    .trim()
    .min(1, "mimeType is required")
    .regex(/^video\//, "Only video uploads are allowed"),
  size: z
    .number()
    .positive("size must be a positive number"),
});

export const uploadCompleteSchema = z.object({
  mediaId: z
    .string()
    .regex(/^[a-f\d]{24}$/i, "Invalid media ID"),
  objectKey: z
    .string()
    .trim()
    .min(1, "objectKey is required"),
});

export const mediaProcessingCompleteSchema = z.object({
  mediaId: z
    .string()
    .regex(/^[a-f\d]{24}$/i, "Invalid media ID"),
  jobId: z
    .string()
    .trim()
    .min(1, "jobId is required"),
  status: z.enum(["COMPLETE", "ERROR"]),
  timestamp: z.any().optional(),
  warnings: z.array(z.string()).optional(),
  errorMessage: z.string().nullable().optional(),
});



