import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_KEY);

export const sendWelcomeEmail = async (email, username, userId) => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to SastaLMS</title>
        <style>
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: #f8fafc;
            margin: 0;
            padding: 0;
            -webkit-font-smoothing: antialiased;
          }
          .container {
            max-width: 580px;
            margin: 40px auto;
            background-color: #ffffff;
            padding: 40px;
            border-radius: 16px;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.05);
            border: 1px solid #edf2f7;
          }
          .logo {
            text-align: center;
            margin-bottom: 24px;
          }
          .logo-text {
            font-size: 28px;
            font-weight: 800;
            color: #4f46e5;
            background: linear-gradient(to right, #4f46e5, #7c3aed);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: -0.5px;
          }
          .header {
            color: #1e293b;
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 16px;
            text-align: center;
          }
          .content {
            color: #475569;
            line-height: 1.6;
            font-size: 15px;
          }
          .highlight-box {
            background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
            border-left: 4px solid #22c55e;
            padding: 20px;
            margin: 24px 0;
            border-radius: 8px;
          }
          .highlight-box strong {
            color: #14532d;
            font-size: 15px;
          }
          .features {
            list-style: none;
            padding: 0;
            margin: 12px 0 0 0;
          }
          .features li {
            padding: 6px 0;
            padding-left: 24px;
            position: relative;
            color: #166534;
            font-size: 14px;
          }
          .features li:before {
            content: "✓";
            position: absolute;
            left: 0;
            color: #22c55e;
            font-weight: bold;
          }
          .cta-container {
            text-align: center;
            margin: 32px 0;
          }
          .cta-button {
            display: inline-block;
            background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
            color: #ffffff !important;
            padding: 14px 32px;
            text-decoration: none;
            font-weight: 600;
            font-size: 15px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(79, 70, 229, 0.2);
            transition: all 0.2s ease;
          }
          .footer {
            color: #94a3b8;
            font-size: 12px;
            text-align: center;
            margin-top: 36px;
            border-top: 1px solid #e2e8f0;
            padding-top: 20px;
            line-height: 1.5;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="logo">
            <span class="logo-text">SastaLMS</span>
          </div>
          
          <div class="header">🎉 Welcome to SastaLMS!</div>
          
          <div class="content">
            <p>Hi <strong>${username}</strong>,</p>
            
            <p>Welcome aboard! We're thrilled to have you join the SastaLMS community. Your account has been successfully created and is ready for your learning journey.</p>
            
            <div class="highlight-box">
              <strong>Get started with these premium features:</strong>
              <ul class="features">
                <li>Browse and enroll in high-quality structured courses</li>
                <li>Watch smooth adaptive HLS video streams with quality selector</li>
                <li>Track and save your course learning progress dynamically</li>
                <li>Manage courses, lessons, and analyze payments (for Creators)</li>
              </ul>
            </div>
            
            <p>Your account is now active. You can explore the course catalog or access your personal classroom dashboard right away.</p>
            
            <div class="cta-container">
              <a href="https://sastalms.sbs/login" class="cta-button">Go to SastaLMS</a>
            </div>
            
            <p style="margin-top: 24px;"><strong>Need assistance?</strong><br/>
            If you have any questions or need help, just reply to this email. Our support team is always here to guide you.</p>
            
            <p>Happy learning!<br/>
            <strong>The SastaLMS Team</strong></p>
          </div>
          
          <div class="footer">
            <p>This is an automated email. Please do not reply to this address directly.</p>
            <p>Account ID: ${userId} • © ${new Date().getFullYear()} SastaLMS</p>
          </div>
        </div>
      </body>
    </html>
  `;

  const { data, error } = await resend.emails.send({
    from: "SastaLMS <no-reply@sastalms.sbs>",
    to: email,
    subject: `Welcome to SastaLMS, ${username}!`,
    html: html,
  });

  if (error) {
    console.error("Resend error:", error);
    return {
      success: false,
      error: "Failed to send welcome email. Please try again.",
    };
  }

  if (data) {
    return {
      success: true,
      message: `Welcome email sent to ${email}`,
    };
  }
};
