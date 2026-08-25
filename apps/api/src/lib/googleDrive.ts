import { google } from "googleapis";

// Separate from lib/googleAuth.ts (which verifies end-user Google Sign-In ID tokens via
// GOOGLE_CLIENT_ID). This client authenticates as a dedicated company Drive account using a
// long-lived refresh token, so the agent can read documents from a shared company folder
// regardless of who is chatting with it. Which account, and which folder, is configuration
// (GOOGLE_DRIVE_* env vars) - nothing here is hardcoded to a particular mailbox.
//
// Deliberately uses googleapis' own bundled google.auth.OAuth2 (not the top-level
// google-auth-library package) - googleapis does an internal version check on the auth
// client it's handed, and a client built from a different install of google-auth-library
// passes type-checking but silently fails to attach credentials to requests (manifests as
// a 403 "unregistered callers" error with no obvious cause).
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set - Drive document search is not configured on this deployment.`);
  }
  return value;
}

let oauth2Client: InstanceType<typeof google.auth.OAuth2> | undefined;

function getOAuth2Client() {
  if (oauth2Client) return oauth2Client;

  const clientId = requireEnv("GOOGLE_DRIVE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_DRIVE_CLIENT_SECRET");
  const refreshToken = requireEnv("GOOGLE_DRIVE_REFRESH_TOKEN");

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  oauth2Client = client;
  return client;
}

/** The Drive folder ID documents are searched within (a shared folder on the company account). */
export function getDriveFolderId(): string {
  return requireEnv("GOOGLE_DRIVE_FOLDER_ID");
}

export function getDriveClient() {
  return google.drive({ version: "v3", auth: getOAuth2Client() });
}

/**
 * Creates a folder in Drive (idempotent-ish: caller should only invoke this once per
 * site/subfolder and persist the returned id - see POST /sites/:id/drive-folders). Returns
 * the folder id and webViewLink so the admin UI can link straight to it in a new tab.
 */
export async function createDriveFolder(
  name: string,
  parentFolderId: string,
): Promise<{ id: string; webViewLink: string }> {
  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id, webViewLink",
  });
  if (!res.data.id || !res.data.webViewLink) {
    throw new Error("Drive did not return an id/webViewLink for the created folder");
  }
  return { id: res.data.id, webViewLink: res.data.webViewLink };
}
