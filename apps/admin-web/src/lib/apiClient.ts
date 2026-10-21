import { isPasswordChangeRequired } from "@recd/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("recd_token");
}

export function setToken(token: string) {
  window.localStorage.setItem("recd_token", token);
}

export function clearToken() {
  window.localStorage.removeItem("recd_token");
}



/** A failed request. The message is unchanged (see apiError.ts); status and body are there for callers that need them. */
export class ApiRequestError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown>) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    // An expired/invalid token anywhere in the app means the session is dead - clear it and
    // bounce to login (unless we're already there, e.g. a failed sign-in or OTP attempt).
    if (res.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
      clearToken();
      window.location.href = "/login";
    }
    const body = await res.json().catch(() => ({}));
    // The server limits an account that must change its password to the change-password screen (403 PASSWORD_CHANGE_REQUIRED). Send the
    // person there once instead of letting every screen retry calls that can only fail. The token is kept: it is what the change needs.
    if (res.status === 403 && isPasswordChangeRequired(body) && typeof window !== "undefined" && !["/change-password", "/login"].includes(window.location.pathname)) {
      window.location.href = "/change-password";
    }
    throw new ApiRequestError(body.error ? JSON.stringify(body.error) : `Request failed: ${res.status}`, res.status, body);
  }
  // 204 No Content (every DELETE route in this app responds this way) has no body for
  // res.json() to parse - it throws "Unexpected end of JSON input" otherwise, even though
  // the request itself succeeded. No caller reads the resolved value of a DELETE call.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Fetches a protected file (signed report PDF, signature image) with the login token - an <a href> or <img src>
 * cannot send the Authorization header - and returns it as a Blob. Failures carry the server's message.
 */
export async function apiBlob(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiRequestError(body.error ? JSON.stringify(body.error) : `Request failed: ${res.status}`, res.status, body);
  }
  return res.blob();
}
