"use client";

import { useAuth } from "./AuthContext";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Nav from "./Nav";
import BottomNav from "./BottomNav";

// Each protected route lists the permissions that grant access. Holding ANY of them is enough.
const ROUTE_PERMISSIONS: Record<string, string[]> = {
  "/dashboard": ["view_dashboard"],
  "/orders": ["manage_orders"],
  "/sites": ["view_site_status"],
  "/complaints": ["manage_complaints", "view_complaints_overview", "act_assigned_complaints"],
  "/vendors": ["manage_vendors"],
  "/users": ["manage_users"],
  "/settings": ["manage_settings"],
};

// Where to send a staff user who lands on /login etc. - the first module they can actually open.
const LANDING_PRIORITY = ["/dashboard", "/sites", "/complaints", "/orders", "/vendors", "/users", "/settings"];

function canAccess(permissions: string[], route: string): boolean {
  const required = ROUTE_PERMISSIONS[route];
  if (!required) return true; // unguarded route
  return required.some((p) => permissions.includes(p));
}

function firstLanding(permissions: string[]): string | null {
  return LANDING_PRIORITY.find((route) => canAccess(permissions, route)) ?? null;
}

function matchRoute(pathname: string): string | undefined {
  return Object.keys(ROUTE_PERMISSIONS).find(
    (route) => pathname === route || pathname.startsWith(route + "/"),
  );
}

function NoAccessScreen({ name, onLogout }: { name: string; onLogout: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-xl">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-600">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        </div>
        <h1 className="text-lg font-semibold text-gray-900">No modules enabled yet</h1>
        <p className="mt-2 text-sm text-gray-500">
          Hi {name}, your account doesn&apos;t have access to any modules yet. Please contact your
          administrator to have the right permissions assigned.
        </p>
        <button
          onClick={onLogout}
          className="mt-6 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (loading) return;
    if (pathname === "/vendor/register") return; // public page - no auth handling

    if (!user) {
      if (pathname !== "/login") router.push("/login");
      return;
    }

    if (user.mustChangePassword) {
      if (pathname !== "/change-password") router.push("/change-password");
      return;
    }

    if (user.role.key === "customer") {
      if (pathname !== "/customer/portal") router.push("/customer/portal");
      return;
    }

    // Staff: bounce off the auth pages onto their first accessible module.
    if (pathname === "/login" || pathname === "/change-password" || pathname === "/customer/portal") {
      const landing = firstLanding(user.permissions);
      if (landing) router.push(landing);
      return;
    }

    // Staff hitting a route they lack permission for -> send them to a route they can open.
    const matched = matchRoute(pathname);
    if (matched && !canAccess(user.permissions, matched)) {
      const landing = firstLanding(user.permissions);
      if (landing) router.push(landing);
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

  // Public, standalone page (no sidebar, no auth) so external vendors can self-register.
  if (pathname === "/vendor/register") {
    return <div className="min-h-screen bg-gray-50">{children}</div>;
  }

  const isLoginPage = pathname === "/login";
  const isChangePasswordPage = pathname === "/change-password";
  const isCustomerPortal = pathname === "/customer/portal";

  if (!user) {
    return isLoginPage ? <>{children}</> : null;
  }

  if (user.mustChangePassword) {
    return isChangePasswordPage ? <>{children}</> : null;
  }

  if (user.role.key === "customer") {
    return isCustomerPortal ? <div className="min-h-screen bg-gray-50">{children}</div> : null;
  }

  if (isLoginPage || isChangePasswordPage || isCustomerPortal) {
    return null;
  }

  // Staff with no accessible module at all (e.g. a brand-new role with no permissions).
  if (!firstLanding(user.permissions)) {
    return <NoAccessScreen name={user.name} onLogout={logout} />;
  }

  // Block rendering a page the user can't access (the effect above redirects them).
  const matched = matchRoute(pathname);
  if (matched && !canAccess(user.permissions, matched)) {
    return null;
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Nav mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar with hamburger (hidden on lg+) */}
        <header
          data-testid="mobile-topbar"
          className="lg:hidden sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-gray-200 bg-white/95 backdrop-blur-sm px-4 h-14"
        >
          <button
            data-testid="mobile-menu-button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            className="-ml-1 p-2 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
          <div className="flex-1 min-w-0 text-center">
            <p className="text-sm font-semibold tracking-tight text-gray-900 truncate">RECD Tracker</p>
          </div>
          <div className="w-9" aria-hidden />
        </header>
        <main className="flex-1 p-4 sm:p-6 lg:p-8 pb-24 lg:pb-8 overflow-auto">{children}</main>
      </div>
      <BottomNav onProfileClick={() => setMobileNavOpen(true)} />
    </div>
  );
}
