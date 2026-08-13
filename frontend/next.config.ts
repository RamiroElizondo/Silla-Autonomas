import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Permite acceder al dev server desde el túnel de cloudflared (subdominio
  // random en cada reinicio: *.trycloudflare.com). Solo afecta a `next dev`.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
