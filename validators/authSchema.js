import * as z from "zod/v4";

export const loginSchema = z.object({
  email: z.string().trim().pipe(z.email("Please enter a valid email")),
  password: z.string().trim().min(8, "Password should be atleast 8 characters"),
});

export const registerSchema = z.object({
  email: z.string().trim().pipe(z.email("Please enter a valid email")),
  password: z.string().trim().min(8, "Password should be atleast 8 characters"),
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
    .min(8, "Password should be atleast 8 characters"),
});

export const setNewPassSchema = z.object({
  newPassword: z
    .string()
    .trim()
    .min(8, "Password should be atleast 8 characters"),
});

export const forgotPassSchema = z.object({
  email: z.string().trim().pipe(z.email("Please enter a valid email")),
  newPassword: z
    .string()
    .trim()
    .min(8, "Password should be atleast 8 characters"),
});

export const sidSchema = z.uuid();

export const sendOtpSchema = z.object({
  email: z.string().trim().pipe(z.email("Please enter a valid email")),
  purpose: z.enum(["REGISTER", "CHANGE_PASSWORD", "FORGOT_PASSWORD", "SET_PASSWORD"]),
});

export const verifyOtpSchema = z.object({
  email: z.string().trim().pipe(z.email("Please enter a valid email")),
  otp: z
    .string()
    .trim()
    .length(6, "OTP must be 6 digits")
    .regex(/^\d+$/, "OTP must be numeric"),
  purpose: z.enum(["REGISTER", "CHANGE_PASSWORD", "FORGOT_PASSWORD", "SET_PASSWORD"]),
});
