import * as z from "zod/v4";

export const loginSchema = z.object({
  email: z.string().trim().pipe(z.email("Please enter a valid email")),
  password: z.string().trim().min(8, "Password should be atleast 8 characters"),
});

export const registerSchema = z.object({
  email: z.string().trim().pipe(z.email("Please enter a valid email")),
  password: z.string().trim().min(8, "Password should be atleast 8 characters"),
  otp: z
    .string()
    .trim()
    .length(6)
    .regex(/^\d{6}$/, "Enter a valid 6-digit OTP")
    .optional(),
  username: z
    .string()
    .trim()
    .min(3, "Username should be atleast 3 character long")
    .max(100, "Username can't exceed 100 characters")
    .regex(/^[a-zA-Z0-9_.-]+$/, "Invalid username"),
});

export const changePassSchema = z.object({
  newPassword: z
    .string()
    .trim()
    .min(8, "Password should be atleast 8 characters"),
  oldPassword: z
    .string()
    .trim()
    .transform((v) => (v === "" ? undefined : v))
    .optional()
    .refine(
      (val) => !val || val.length >= 8,
      "Password should be atleast 8 characters",
    ),
});

export const sidSchema = z.uuid();

export const sendOtpSchema = z.discriminatedUnion("purpose", [
  // 🔐 AUTH (login / register)
  z.object({
    purpose: z.literal("auth"),
    email: z.string().trim().email("Please enter a valid email"),
  }),

  // 🔐 CHANGE EMAIL / SECURITY
  z.object({
    purpose: z.literal("security"),
    email: z.object({
      oldEmail: z.string().trim().email("Old email is not valid"),
      newEmail: z.string().trim().email("New email is not valid"),
    }),
  }),
]);

export const roleDataSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i),
  changeTo: z.enum(["User", "Admin", "Manager", "Owner"]),
});

export const verifyChangeEmailSchema = z.object({
  newEmail: z.string().trim().email("Please enter a valid new email"),

  oldEmailOtp: z
    .string()
    .length(6, "Old email OTP must be 6 digits")
    .regex(/^\d+$/, "Old email OTP must be numeric"),

  newEmailOtp: z
    .string()
    .length(6, "New email OTP must be 6 digits")
    .regex(/^\d+$/, "New email OTP must be numeric"),

  password: z.string().min(8, "Password must be at least 8 characters"),
});
