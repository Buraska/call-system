import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./settings.css";

export const metadata: Metadata = {
  title: "Kontuur — Входящие",
  description: "Сообщения по пропущенным звонкам в одном месте",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
