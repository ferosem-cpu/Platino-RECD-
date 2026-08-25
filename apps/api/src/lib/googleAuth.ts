import { OAuth2Client } from "google-auth-library";

// Checked per-request rather than at module load (unlike jwt.ts's JWT_SECRET): Google sign-in
// is an optional, additive login method, so a deploy that hasn't set this yet should still
// serve every other route - only this one endpoint should fail, loudly, until it's configured.
function requireClientId(): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("GOOGLE_CLIENT_ID is not set - Google sign-in is not configured on this deployment.");
  }
  return clientId;
}

let client: OAuth2Client | undefined;

/** Verifies a Google Identity Services ID token and returns the signed-in Google account's email. */
export async function verifyGoogleIdToken(idToken: string): Promise<{ email: string; emailVerified: boolean }> {
  const clientId = requireClientId();
  client ??= new OAuth2Client(clientId);

  const ticket = await client.verifyIdToken({ idToken, audience: clientId });
  const payload = ticket.getPayload();
  if (!payload?.email) {
    throw new Error("Google token did not include an email address");
  }
  return { email: payload.email, emailVerified: payload.email_verified === true };
}
