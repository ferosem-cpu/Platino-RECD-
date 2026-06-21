"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { api, setToken, clearToken } from "@/lib/apiClient";
import { useRouter } from "next/navigation";

export interface UserSession {
  id: string;
  name: string;
  email: string | null;
  mustChangePassword: boolean;
  role: {
    key: string;
    name: string;
  };
  permissions: string[];
  customerId?: string | null;
  orderNumber?: string;
}

interface AuthContextType {
  user: UserSession | null;
  permissions: string[];
  hasPermission: (permissionKey: string) => boolean;
  login: (token: string, orderNumber?: string) => Promise<void>;
  logout: () => void;
  loading: boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserSession | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const fetchSession = useCallback(async () => {
    const token = typeof window !== "undefined" ? window.localStorage.getItem("recd_token") : null;
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      const data = await api<UserSession>("/auth/me");
      
      const savedOrderNumber = typeof window !== "undefined" ? window.localStorage.getItem("recd_customer_ord") : null;
      if (data.role.key === "customer" && savedOrderNumber) {
        data.orderNumber = savedOrderNumber;
      }
      
      setUser(data);

      try {
        const settings = await api<{ themeKey: string; logoDataUrl: string | null; customColors: any }>("/settings");
        if (typeof window !== "undefined") {
          const { saveThemeKey, saveLogo, clearLogo, saveCustomColors, clearCustomColors } = require("@/lib/settingsStore");
          if (settings.themeKey) {
            saveThemeKey(settings.themeKey);
          }
          if (settings.logoDataUrl) {
            saveLogo(settings.logoDataUrl);
          } else {
            clearLogo();
          }
          if (settings.customColors) {
            saveCustomColors(settings.customColors);
          } else {
            clearCustomColors();
          }
          window.dispatchEvent(new Event("settings-changed"));
        }
      } catch (err) {
        console.error("Failed to load settings in AuthContext", err);
      }
    } catch (err) {
      console.error("Session load failed", err);
      clearToken();
      if (typeof window !== "undefined") {
        window.localStorage.removeItem("recd_customer_ord");
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  const login = useCallback(async (token: string, orderNumber?: string) => {
    setLoading(true);
    setToken(token);
    if (orderNumber && typeof window !== "undefined") {
      window.localStorage.setItem("recd_customer_ord", orderNumber);
    }
    await fetchSession();
  }, [fetchSession]);

  const logout = useCallback(() => {
    clearToken();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("recd_customer_ord");
    }
    setUser(null);
    router.push("/login");
  }, [router]);

  const hasPermission = useCallback((permissionKey: string) => {
    if (!user) return false;
    return user.permissions.includes(permissionKey);
  }, [user]);

  const refresh = useCallback(async () => {
    await fetchSession();
  }, [fetchSession]);

  return (
    <AuthContext.Provider
      value={{
        user,
        permissions: user?.permissions || [],
        hasPermission,
        login,
        logout,
        loading,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
