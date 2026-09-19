import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClarityInvest — Clear Portfolio Decisions",
  description: "A transparent investment learning and portfolio analysis workspace.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
