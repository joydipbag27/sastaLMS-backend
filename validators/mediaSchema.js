import * as z from "zod/v4";

export const uploadUrlSchema = z.object({
  mimeType: z
    .string()
    .trim()
    .min(1, "mimeType is required"),
});

export const confirmUploadSchema = z.object({
  storageKey: z
    .string()
    .trim()
    .min(1, "storageKey is required"),
  mimeType: z
    .string()
    .trim()
    .min(1, "mimeType is required"),
  size: z
    .number()
    .positive("size must be a positive number"),
});
