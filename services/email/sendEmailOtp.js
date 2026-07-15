import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_KEY);

const buildTemplate = (title, description, otp) => `
  <div style="
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 40px 20px;
    background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
    min-height: 100%;
  ">
    <div style="
      max-width: 480px;
      margin: auto;
      background: #ffffff;
      padding: 36px;
      border-radius: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.05);
      border: 1px solid #edf2f7;
    ">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="
          font-size: 24px;
          font-weight: 800;
          background: linear-gradient(to right, #4f46e5, #7c3aed);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          letter-spacing: -0.5px;
        ">
          SastaLMS
        </span>
      </div>
      
      <h2 style="
        text-align: center;
        color: #1e293b;
        font-size: 20px;
        font-weight: 700;
        margin-top: 0;
        margin-bottom: 8px;
      ">
        ${title}
      </h2>
      
      <p style="
        text-align: center;
        font-size: 14px;
        color: #64748b;
        line-height: 1.5;
        margin-bottom: 24px;
      ">
        ${description}
      </p>
      
      <div style="
        background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
        color: #ffffff;
        padding: 16px;
        text-align: center;
        margin: 24px 0;
        border-radius: 12px;
        font-size: 32px;
        font-weight: 800;
        letter-spacing: 8px;
        box-shadow: 0 4px 12px rgba(79, 70, 229, 0.25);
      ">
        ${otp}
      </div>
      
      <p style="
        font-size: 12px;
        text-align: center;
        color: #94a3b8;
        margin-bottom: 0;
      ">
        This OTP is temporary and valid for <strong>10 minutes</strong>.<br>
        If you did not request this code, please ignore this email.
      </p>
    </div>
    
    <div style="
      text-align: center;
      margin-top: 24px;
      font-size: 12px;
      color: #94a3b8;
    ">
      © ${new Date().getFullYear()} SastaLMS. All rights reserved.
    </div>
  </div>
`;

export const sendEmail = async (email, purpose, otp) => {
  if (!email || typeof email !== "string") {
    return {
      success: false,
      error: "Invalid email address",
    };
  }

  let title, description, subject;

  switch (purpose) {
    case "REGISTER":
      title = "Verify Your Registration";
      description = "Use this OTP to complete your registration:";
      subject = "Your registration verification code";
      break;
    case "CHANGE_PASSWORD":
      title = "Confirm Password Change";
      description = "Use this OTP to confirm changing your password:";
      subject = "Your password change verification code";
      break;
    case "FORGOT_PASSWORD":
      title = "Reset Your Password";
      description = "Use this OTP to reset your password:";
      subject = "Your password reset verification code";
      break;
    case "SET_PASSWORD":
      title = "Set Your Password";
      description = "Use this OTP to set a password for your account:";
      subject = "Your password verification code";
      break;
    default:
      return {
        success: false,
        error: "Invalid OTP purpose",
      };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: "SastaLMS <otp@sastalms.sbs>",
      to: email,
      subject: subject,
      html: buildTemplate(title, description, otp),
    });

    if (error) {
      console.error("Resend error:", error);
      return {
        success: false,
        error: "Failed to send OTP. Please try again.",
      };
    }

    return {
      success: true,
      message: `OTP sent to ${email}`,
    };
  } catch (error) {
    console.error("Resend execution error:", error);
    return {
      success: false,
      error: "Failed to send OTP. Please try again.",
    };
  }
};
