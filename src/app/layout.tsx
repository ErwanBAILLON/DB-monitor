import type { Metadata } from "next";
import { inter, mono } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "DB Monitor", template: "%s · DB Monitor" },
  description: "Console de flotte pour les bases de données du homelab.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
