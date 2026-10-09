import type { Metadata } from "next";
import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "./globals.css";

// La CSP usa un nonce por request (src/middleware.ts). Next solo puede aplicar
// ese nonce a sus scripts si la página se renderiza en cada request; una página
// prerenderizada en el build sale sin nonce y el navegador bloquea sus scripts
// (página en blanco en producción, aunque en `next dev` ande).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Relajá · Sillones de masaje",
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
