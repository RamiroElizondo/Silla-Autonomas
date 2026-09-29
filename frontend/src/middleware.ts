import { NextResponse, type NextRequest } from "next/server";

import { construirCsp } from "@/lib/csp";

export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = construirCsp(process.env.NODE_ENV !== "production", nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next lee el nonce de este header del request para aplicarlo a sus scripts.
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
