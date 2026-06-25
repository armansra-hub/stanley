import type { Metadata } from "next";
import "./globals.css";
import BackgroundCycler from "@/components/BackgroundCycler";

export const metadata: Metadata = {
  title: "Stanley",
  description: "The all-in-one toolkit for a NetSuite AE.",
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
