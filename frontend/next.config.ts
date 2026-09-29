import type { NextConfig } from "next";


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
          // La CSP (con nonce por request) la setea src/middleware.ts.
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
