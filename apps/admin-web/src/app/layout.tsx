import type { Metadata } from "next";
import { Tinos } from "next/font/google";
import ThemeInitializer from "@/components/ThemeInitializer";
import { AuthProvider } from "@/components/AuthContext";
import AuthGuard from "@/components/AuthGuard";
import "./globals.css";

// Tinos is metrically identical to Times New Roman and is bundled/self-hosted so
// printed pages render the same on every device (Windows, phone, Mac, PDF), not just
// where Times New Roman happens to be installed. Used only by `.print-doc`.
const tinos = Tinos({
  weight: ["400", "700"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-tinos",
  display: "swap",
});

export const metadata: Metadata = {
  title: "RECD Project & Service Tracker",
  description: "Platino internal operations console",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={tinos.variable}>
      <body className="bg-gray-50 text-gray-900">
        <AuthProvider>
          <ThemeInitializer />
          <AuthGuard>{children}</AuthGuard>
        </AuthProvider>
      </body>
    </html>
  );
}
