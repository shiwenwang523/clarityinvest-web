import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClarityInvest — Explainable Investment Agent",
  description: "An evidence-grounded multi-agent investment education and portfolio analysis prototype.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
