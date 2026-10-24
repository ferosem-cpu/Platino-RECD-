import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

const API_URL = (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? "http://localhost:4000";
const TOKEN_KEY = "recd_token";

export async function getToken(): Promise<string | null> {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  await AsyncStorage.setItem(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  await AsyncStorage.removeItem(TOKEN_KEY);
}

/** A failed request. The message is unchanged; status and body are there for callers that need them. */
export class ApiRequestError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown>) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiRequestError(body.error ? JSON.stringify(body.error) : `Request failed: ${res.status}`, res.status, body);
  }
  return res.json() as Promise<T>;
}
