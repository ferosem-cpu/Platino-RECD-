"use client";

import Link from "next/link";

const liveLinks = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/orders", label: "Orders" },
  { href: "/sites", label: "Sites" },
  { href: "/complaints", label: "Complaints" },
  { href: "/users", label: "Users" },
];

const phase2Links = ["Revenue", "Reports", "Structure diagrams"];

export default function Nav() {
  return (
    <nav className="w-56 shrink-0 border-r border-gray-200 bg-white p-4">
      <div className="mb-6 text-sm font-semibold">RECD Tracker</div>
      <ul className="space-y-1">
        {liveLinks.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className="block rounded px-2 py-1.5 text-sm hover:bg-gray-100">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-6 border-t border-gray-200 pt-4">
        <ul className="space-y-1">
          {phase2Links.map((label) => (
            <li key={label} className="px-2 py-1.5 text-sm text-gray-400">
              {label} <span className="text-xs">(phase 2)</span>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
