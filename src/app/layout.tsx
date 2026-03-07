import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "BookRAG",
  description: "Quote → best matching PDF page (with optional printed-page estimate)"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

