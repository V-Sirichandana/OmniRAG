import type { Metadata, Viewport } from "next";
import { AuthProvider } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "OmniRAG — Enterprise Knowledge Base",
  description:
    "Secure multi-tenant agentic RAG platform for enterprise knowledge retrieval with cross-department access control and strict citations.",
};

export const viewport: Viewport = {
  themeColor: "#070b14",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-slate-300 antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
