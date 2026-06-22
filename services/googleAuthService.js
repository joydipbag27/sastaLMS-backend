import { OAuth2Client } from "google-auth-library";

const clientId = process.env.GOOGLE_CLIENT_ID;

export const googleClient = new OAuth2Client({
  clientId,
});
