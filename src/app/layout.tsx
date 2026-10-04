import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./settings.css";

export const metadata: Metadata = {
  title: "Kontuur — Inbox",
  description: "Messages from missed calls, all in one place",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
