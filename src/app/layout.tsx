import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "QuoteSearch",
  description: "Get most accurate book-specific"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

