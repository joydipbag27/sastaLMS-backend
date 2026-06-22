import { Resend } from "resend";
import crypto from "crypto";
import OTP from "../../Models/otpModel.js";

const resend = new Resend(process.env.RESEND_KEY);

const buildTemplate = (title, description, otp) => `
  <div style="font-family:Arial, sans-serif; padding:20px; background:#f3f4f6;">
    <div style="max-width:460px; margin:auto; background:#ffffff; padding:24px; border-radius:10px;">
      <h2 style="text-align:center; color:#111827;">${title}</h2>
      <p style="text-align:center; font-size:14px; color:#6b7280;">
        ${description}
      </p>
      <div style="
        background:#111827;
        color:#ffffff;
        padding:14px;
        text-align:center;
        margin:20px 0;
        border-radius:8px;
        font-size:28px;
        font-weight:bold;
        letter-spacing:6px;
      ">
        ${otp}
      </div>
      <p style="font-size:13px; text-align:center;">
        OTP valid for 10 minutes
      </p>
    </div>
  </div>
`;

const createOtp = () => {
  const randomBytes = crypto.randomBytes(3);
  const otp =
    (randomBytes[0] * 1000000 + randomBytes[1] * 10000 + randomBytes[2] * 100) %
    1000000;
  return otp.toString().padStart(6, "0");
};

export const sendEmail = async (email, purpose) => {
  if (purpose === "auth") {
    if (!email || typeof email !== "string") {
      return {
        success: false,
        error: "Invalid email address",
      };
    }

    const otp = createOtp();

    try {
      const { data, error } = await resend.emails.send({
        from: "Sasta Drive <otp@upisathi.in>",
        to: email,
        subject: "Your login verification code",
        html: buildTemplate(
          "Verify Your Login",
          "Use this OTP to continue:",
          otp,
        ),
      });

      if (error) {
        console.error("Resend error:", error);
        return {
          success: false,
          error: "Failed to send OTP. Please try again.",
        };
      }

      // Save OTP only after successful email send
      await OTP.findOneAndUpdate(
        { email, purpose },
        {
          email,
          otp,
          purpose,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          createdAt: new Date(),
        },
        { upsert: true },
      );

      return {
        success: true,
        message: `OTP sent to ${email}`,
      };
    } catch (error) {
      console.error("Auth OTP error:", error);
      return {
        success: false,
        error: "Failed to send OTP. Please try again.",
      };
    }
  }

  if (purpose === "security") {
    if (
      !email ||
      typeof email !== "object" ||
      !email.oldEmail ||
      !email.newEmail
    ) {
      return {
        success: false,
        error: "Invalid email parameters",
      };
    }

    const { oldEmail, newEmail } = email;
    const oldEmailOtp = createOtp();
    const newEmailOtp = createOtp();

    try {
      const results = await Promise.all([
        resend.emails.send({
          from: "Sasta Drive <otp@sastadrive.in>",
          to: oldEmail,
          subject: "Confirm your current email",
          html: buildTemplate(
            "Confirm Current Email",
            "Use this OTP to confirm your existing email:",
            oldEmailOtp,
          ),
        }),

        resend.emails.send({
          from: "Sasta Drive <otp@sastadrive.in>",
          to: newEmail,
          subject: "Confirm your new email",
          html: buildTemplate(
            "Confirm New Email",
            "Use this OTP to verify your new email:",
            newEmailOtp,
          ),
        }),
      ]);

      // Check if any email send failed
      const emailErrors = results.filter((result) => result.error);
      if (emailErrors.length > 0) {
        console.error("Resend errors:", emailErrors);
        return {
          success: false,
          error: "Failed to send OTP to one or both emails. Please try again.",
        };
      }

      // Save OTPs only after successful email sends
      await OTP.findOneAndUpdate(
        {
          email: oldEmail,
          purpose,
        },
        {
          email: oldEmail,
          newEmail,
          otp: oldEmailOtp,
          newEmailOtp,
          purpose,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          createdAt: new Date(),
        },
        { upsert: true },
      );

      return {
        success: true,
        message: "OTP sent to both old and new emails",
      };
    } catch (error) {
      console.error("Security OTP error:", error);
      return {
        success: false,
        error: "Failed to send OTP. Please try again.",
      };
    }
  }

  return {
    success: false,
    error: "Invalid OTP purpose",
  };
};
