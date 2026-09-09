import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Evita que Next tome C:\Users\Ramiro como raíz cuando encuentra otro
  // package-lock.json fuera del proyecto.
  outputFileTracingRoot: process.cwd(),
  // Permite acceder al dev server desde el túnel de cloudflared (subdominio
  // random en cada reinicio: *.trycloudflare.com). Solo afecta a `next dev`.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
