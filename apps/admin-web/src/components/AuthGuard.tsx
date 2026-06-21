"use client";

import { useAuth } from "./AuthContext";
import { useRouter, usePathname } from "next/navigation";
import { useEffect } from "react";
import Nav from "./Nav";

const ROUTE_PERMISSIONS: Record<string, string> = {
  "/dashboard": "view_dashboard",
  "/orders": "manage_orders",
  "/sites": "view_site_status",
  "/complaints": "view_site_status",
  "/users": "manage_users",
  "/settings": "manage_settings",
};

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;

    if (!user) {
      if (pathname !== "/login") {
        router.push("/login");
      }
    } else {
      if (user.mustChangePassword) {
        if (pathname !== "/change-password") {
          router.push("/change-password");
        }
      } else {
        if (user.role.key === "customer") {
          if (pathname !== "/customer/portal") {
            router.push("/customer/portal");
          }
        } else {
          if (pathname === "/login" || pathname === "/change-password" || pathname === "/customer/portal") {
            // Find fallback page they have permission to access
            if (user.permissions.includes("view_dashboard")) {
              router.push("/dashboard");
            } else if (user.permissions.includes("view_site_status")) {
              router.push("/sites");
            } else {
              router.push("/dashboard");
            }
          } else {
            // Check direct URL access permission
            const matchedRoute = Object.keys(ROUTE_PERMISSIONS).find(
              (route) => pathname === route || pathname.startsWith(route + "/")
            );
            if (matchedRoute) {
              const reqPerm = ROUTE_PERMISSIONS[matchedRoute];
              if (!user.permissions.includes(reqPerm)) {
                // Redirect to a route they DO have access to
                if (user.permissions.includes("view_site_status")) {
                  router.push("/sites");
                } else if (user.permissions.includes("view_dashboard")) {
                  router.push("/dashboard");
                } else {
                  router.push("/login");
                }
              }
            }
          }
        }
      }
    }
  }, [user, loading, pathname, router]);

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center space-y-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-emerald-600 border-t-transparent"></div>
          <p className="text-sm font-medium text-gray-500">Loading session...</p>
        </div>
      </div>
    );
  }

  const isLoginPage = pathname === "/login";
  const isChangePasswordPage = pathname === "/change-password";
  const isCustomerPortal = pathname === "/customer/portal";

  if (!user) {
    if (isLoginPage) {
      return <>{children}</>;
    }
    return null;
  }

  if (user.mustChangePassword) {
    if (isChangePasswordPage) {
      return <>{children}</>;
    }
    return null;
  }

  if (user.role.key === "customer") {
    if (isCustomerPortal) {
      return <div className="min-h-screen bg-gray-50">{children}</div>;
    }
    return null;
  }

  if (isLoginPage || isChangePasswordPage || isCustomerPortal) {
    return null;
  }

  // Double check permission before rendering the page content
  const matchedRoute = Object.keys(ROUTE_PERMISSIONS).find(
    (route) => pathname === route || pathname.startsWith(route + "/")
  );
  if (matchedRoute) {
    const reqPerm = ROUTE_PERMISSIONS[matchedRoute];
    if (!user.permissions.includes(reqPerm)) {
      return null;
    }
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Nav />
      <main className="flex-1 p-8 overflow-auto">{children}</main>
    </div>
  );
}
