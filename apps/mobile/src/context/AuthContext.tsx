import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { isPasswordChangeRequired } from "@recd/shared";
import { api, setToken, clearToken, getToken } from "@/lib/apiClient";

interface AuthUser {
  id: string;
  name: string;
  role: string;
}

/** What the API answers to a code request (expiry and cooldown come from the server, not from the app). */
export interface OtpRequestResponse {
  ok: boolean;
  message?: string;
  expiresInSeconds?: number;
  resendAfterSeconds?: number;
  /** Only present when the API runs in explicitly enabled local-development mode. */
  devCode?: string;
}

interface AuthState {
  user: AuthUser | null;
  /** The server limits this account to changing its password (mustChangePassword): show only the change-password screen. */
  passwordChangeRequired: boolean;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  loading: boolean;
  loginWithPassword: (email: string, password: string) => Promise<void>;
  requestOtp: (phone: string) => Promise<OtpRequestResponse>;
  verifyOtp: (phone: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);

  useEffect(() => {
    getToken().then((token) => {
      // A real app would decode/validate the token here; Phase 1 just checks presence
      // and relies on the API to reject expired tokens on the next request.
      setLoading(false);
      void token;
    });
  }, []);

  /** Stores the token and asks the server (GET /auth/me, the one call open to every account) whether the person must change their password first. */
  const startSession = useCallback(async (token: string, signedIn: AuthUser) => {
    await setToken(token);
    let mustChange = false;
    try {
      mustChange = (await api<{ mustChangePassword?: boolean }>("/auth/me")).mustChangePassword === true;
    } catch (err) {
      mustChange = isPasswordChangeRequired(err);
    }
    setPasswordChangeRequired(mustChange);
    setUser(signedIn);
  }, []);

  const loginWithPassword = useCallback(async (email: string, password: string) => {
    const result = await api<{ token: string; user: AuthUser }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    await startSession(result.token, result.user);
  }, [startSession]);

  const requestOtp = useCallback(async (phone: string) => {
    return api<OtpRequestResponse>("/auth/otp/request", { method: "POST", body: JSON.stringify({ phone }) });
  }, []);

  const verifyOtp = useCallback(async (phone: string, code: string) => {
    const result = await api<{ token: string; user: AuthUser }>("/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ phone, code }),
    });
    await startSession(result.token, result.user);
  }, [startSession]);

  /** Completes the forced change: the server answers with a fresh token (the old ones are revoked), which replaces the stored one. */
  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const result = await api<{ ok: boolean; token?: string }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (result.token) await setToken(result.token);
    setPasswordChangeRequired(false);
  }, []);

  const logout = useCallback(async () => {
    await clearToken();
    setPasswordChangeRequired(false);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, passwordChangeRequired, changePassword, loginWithPassword, requestOtp, verifyOtp, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
