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
    throw new Error(body.error ? JSON.stringify(body.error) : `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
