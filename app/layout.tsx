import type { Metadata } from "next";
import "./globals.css";
import BackgroundCycler from "@/components/BackgroundCycler";

export const metadata: Metadata = {
  title: "Stanley",
  description: "Territory intelligence for a NetSuite AE, with Jev-powered account research and Claude-assisted workflows.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ minHeight: "100vh" }}>
        <BackgroundCycler />
        {children}
      </body>
    </html>
  );
}
