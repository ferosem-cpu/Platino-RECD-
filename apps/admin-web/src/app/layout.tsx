import type { Metadata } from "next";
import ThemeInitializer from "@/components/ThemeInitializer";
import { AuthProvider } from "@/components/AuthContext";
import AuthGuard from "@/components/AuthGuard";
import "./globals.css";

export const metadata: Metadata = {
  title: "RECD Project & Service Tracker",
  description: "Platino internal operations console",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900">
        <AuthProvider>
          <ThemeInitializer />
          <AuthGuard>{children}</AuthGuard>
        </AuthProvider>
      </body>
    </html>
  );
}
