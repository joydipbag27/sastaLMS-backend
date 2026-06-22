import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_KEY);

export const sendWelcomeEmail = async (email, username, userId) => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body {
            font-family: Arial, sans-serif;
            background-color: #f4f4f4;
          }
          .container {
            max-width: 600px;
            margin: 20px auto;
            background-color: #ffffff;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .header {
            color: #1976d2;
            font-size: 28px;
            margin-bottom: 20px;
            text-align: center;
          }
          .content {
            color: #333;
            line-height: 1.6;
            font-size: 16px;
          }
          .highlight-box {
            background-color: #e3f2fd;
            border-left: 4px solid #1976d2;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
          }
          .features {
            list-style: none;
            padding: 0;
            margin: 15px 0;
          }
          .features li {
            padding: 8px 0;
            padding-left: 25px;
            position: relative;
          }
          .features li:before {
            content: "✓";
            position: absolute;
            left: 0;
            color: #4caf50;
            font-weight: bold;
          }
          .cta-button {
            display: inline-block;
            background-color: #1976d2;
            color: white;
            padding: 12px 30px;
            text-decoration: none;
            border-radius: 4px;
            margin-top: 20px;
            text-align: center;
          }
          .footer {
            color: #999;
            font-size: 12px;
            text-align: center;
            margin-top: 30px;
            border-top: 1px solid #eee;
            padding-top: 15px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">🎉 Welcome to Sasta Drive!</div>
          
          <div class="content">
            <p>Hi <strong>${username}</strong>,</p>
            
            <p>Welcome aboard! We're thrilled to have you join the Sasta Drive community. Your account has been successfully created and is ready to use.</p>
            
            <div class="highlight-box">
              <strong>Get started with these features:</strong>
              <ul class="features">
                <li>Upload and store your files securely</li>
                <li>Share files and folders with others</li>
                <li>Organize your data with folders</li>
                <li>Access your files anytime, anywhere</li>
              </ul>
            </div>
            
            <p>Your account is now active. You can start uploading your files right away.</p>
            
            <a href="https://sastadrive.in/login" class="cta-button">Go to Sasta Drive</a>
            
            <p style="margin-top: 30px;"><strong>Need help?</strong><br/>
            If you have any questions or need assistance, our support team is here to help. Just reply to this email or visit our help center.</p>
            
            <p>Happy uploading!<br/>
            <strong>The Sasta Drive Team</strong></p>
          </div>
          
          <div class="footer">
            <p>This is an automated email. Please do not reply to this address directly.</p>
            <p>Account ID: ${userId}</p>
          </div>
        </div>
      </body>
    </html>
  `;

  const { data, error } = await resend.emails.send({
    from: "Sasta Drive <no-reply@upisathi.in>",
    to: email,
    subject: `Welcome to Sasta Drive, ${username}!`,
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
