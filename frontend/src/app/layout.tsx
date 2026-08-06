import type { Metadata } from "next";
import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sillas de masaje",
  description: "Pagá desde tu celular y disfrutá tu masaje",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
