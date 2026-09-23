import type { NextConfig } from "next";

/**
 * Content-Security-Policy (Bloque A del hardening).
 *
 * La fuente Outfit va self-hosted vía @fontsource (ver layout.tsx: importa
 * los .css del paquete, que Next empaqueta como propios) — no hace falta
 * permitir fonts.googleapis.com, todo sale de 'self'.
 *
 * `style-src` necesita 'unsafe-inline' porque `/silla/[id]/pantalla` usa un
 * `style={{ width }}` inline para la barra de progreso (React lo vuelca como
 * atributo `style` en el DOM). Es la única razón; si en algún momento se
 * saca ese inline style (variable CSS + clase), se puede sacar también de acá.
 *
 * `frame-ancestors 'none'` en todas las rutas: ninguna vista de este
 * proyecto (ni siquiera la pantalla TV) se abre embebida en un iframe, así
 * que no hace falta una excepción.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // El proyecto nunca tuvo ESLint instalado (no hay eslint/eslint-config-next
  // en package.json, ni config): sin esto, `next build` se queda colgado en
  // un prompt interactivo ("¿cómo configurar ESLint?") que nunca se puede
  // contestar en CI/CD. No es parte de este hardening — si en algún momento
  // se agrega ESLint de verdad, sacar esta línea.
  eslint: { ignoreDuringBuilds: true },
  // Evita que Next tome C:\Users\Ramiro como raíz cuando encuentra otro
  // package-lock.json fuera del proyecto.
  outputFileTracingRoot: process.cwd(),
  // Permite acceder al dev server desde el túnel de cloudflared (subdominio
  // random en cada reinicio: *.trycloudflare.com). Solo afecta a `next dev`.
  allowedDevOrigins: ["*.trycloudflare.com"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
