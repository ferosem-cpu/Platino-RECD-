"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getSavedLogo } from "@/lib/settingsStore";
import { useAuth } from "./AuthContext";

const liveLinks = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
      </svg>
    ),
  },
  {
    href: "/orders",
    label: "Orders",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15a2.25 2.25 0 012.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
      </svg>
    ),
  },
  {
    href: "/sites",
    label: "Sites",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
      </svg>
    ),
  },
  {
    href: "/complaints",
    label: "Complaints",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
    ),
  },
  {
    href: "/vendors",
    label: "Vendors",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
      </svg>
    ),
  },
  {
    href: "/users",
    label: "Users",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
      </svg>
    ),
  },
  {
    href: "/amc-orders",
    label: "AMC Order",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
      </svg>
    ),
  },
];

const phase2Links = [
  {
    label: "Revenue",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    label: "Reports",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
      </svg>
    ),
  },
  {
    label: "Structure diagrams",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0l-5.571 3-5.571-3" />
      </svg>
    ),
  },
];

const settingsLink = {
  href: "/settings",
  label: "Settings",
  icon: (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
};

// Which permissions unlock each main link. Holding ANY one shows the link.
const LINK_PERMISSIONS: Record<string, string[]> = {
  "/dashboard": ["view_dashboard"],
  "/orders": ["manage_orders"],
  "/sites": ["view_site_status"],
  "/complaints": ["manage_complaints", "view_complaints_overview", "act_assigned_complaints"],
  "/vendors": ["manage_vendors"],
  "/users": ["manage_users"],
  "/amc-orders": ["manage_amc_orders"],
};

interface NavProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export default function Nav({ mobileOpen = false, onMobileClose }: NavProps) {
  const pathname = usePathname();
  const { user, logout, hasPermission } = useAuth();
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    setLogoUrl(getSavedLogo());

    function onSettingsChanged() {
      setLogoUrl(getSavedLogo());
    }

    window.addEventListener("settings-changed", onSettingsChanged);
    return () => window.removeEventListener("settings-changed", onSettingsChanged);
  }, []);

  // Close drawer when route changes (mobile)
  useEffect(() => {
    onMobileClose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          data-testid="nav-mobile-backdrop"
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={onMobileClose}
        />
      )}

      <nav
        data-testid="sidebar-nav"
        className={`sidebar fixed inset-y-0 left-0 z-50 w-60 shrink-0 flex flex-col overflow-y-auto transform transition-transform duration-300 ease-in-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
          lg:relative lg:translate-x-0`}
      >
        {/* ── Logo / Brand ──────────────────────────────────────────────── */}
        <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {logoUrl ? (
              <div className="mb-3 flex items-center gap-3">
                <img
                  src={logoUrl}
                  alt="Company logo"
                  className="h-9 w-auto max-w-[8rem] object-contain"
                />
              </div>
            ) : null}
            <div className="text-xs font-bold uppercase tracking-widest" style={{ color: "var(--theme-sidebar-text-muted)" }}>
              RECD Tracker
            </div>
          </div>
          {/* Close button on mobile */}
          <button
            data-testid="nav-close-button"
            onClick={onMobileClose}
            className="lg:hidden p-1.5 -mr-1 rounded-md hover:bg-white/5 transition-colors"
            style={{ color: "var(--theme-sidebar-text-muted)" }}
            aria-label="Close navigation"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ── Divider ───────────────────────────────────────────────────── */}
        <div className="mx-4 mb-2 border-t" style={{ borderColor: "var(--theme-sidebar-border)" }} />

        {/* ── Main links ────────────────────────────────────────────────── */}
        <div className="flex-1 px-3 space-y-0.5">
          <p className="px-3 pt-2 pb-1.5 text-[0.625rem] font-semibold uppercase tracking-widest" style={{ color: "var(--theme-sidebar-text-muted)" }}>
            Main
          </p>
          {liveLinks
            .filter((link) => (LINK_PERMISSIONS[link.href] ?? []).some((p) => hasPermission(p)))
            .map((link) => (
              <Link
                key={link.href}
                href={link.href}
                data-testid={`nav-link-${link.label.toLowerCase()}`}
                className={`sidebar-link ${pathname === link.href || pathname?.startsWith(link.href + "/") ? "active" : ""}`}
              >
                {link.icon}
                {link.label}
              </Link>
            ))}

          {/* ── Phase 2 ─────────────────────────────────────────────────── */}
          <p className="px-3 pt-5 pb-1.5 text-[0.625rem] font-semibold uppercase tracking-widest" style={{ color: "var(--theme-sidebar-text-muted)" }}>
            Coming Soon
          </p>
          {phase2Links.map((item) => (
            <div
              key={item.label}
              className="sidebar-link opacity-40 cursor-not-allowed"
            >
              {item.icon}
              <span>{item.label}</span>
              <span className="ml-auto text-[0.55rem] font-semibold rounded-full px-1.5 py-0.5" style={{ backgroundColor: "var(--theme-sidebar-bg-hover)", color: "var(--theme-sidebar-text-muted)" }}>
                P2
              </span>
            </div>
          ))}
        </div>

        {/* ── Bottom section ────────────────────────────────────────────── */}
        <div className="px-3 pb-4 pt-2">
          <div className="mx-1 mb-2 border-t" style={{ borderColor: "var(--theme-sidebar-border)" }} />
          {hasPermission("manage_settings") && (
            <Link
              href={settingsLink.href}
              data-testid="nav-link-settings"
              className={`sidebar-link ${pathname === settingsLink.href ? "active" : ""}`}
            >
              {settingsLink.icon}
              {settingsLink.label}
            </Link>
          )}
          {user && (
            <div className="px-3 py-2 text-xs font-medium truncate" style={{ color: "var(--theme-sidebar-text)" }}>
              Logged in as <br />
              <strong style={{ color: "var(--theme-accent)" }}>{user.name}</strong>
              <div className="text-[10px] opacity-75">{user.role.name}</div>
            </div>
          )}
          <button
            onClick={logout}
            data-testid="nav-logout-button"
            className="sidebar-link w-full mt-0.5 text-red-400 hover:!text-red-300 hover:!bg-red-950/30"
          >
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
            Log out
          </button>
        </div>
      </nav>
    </>
  );
}
