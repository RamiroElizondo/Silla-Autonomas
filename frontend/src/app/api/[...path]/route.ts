import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxy same-origin hacia el backend Nest.js.
 *
 * Todo lo que el navegador pide a `/api/*` (checkout, estado, admin, y el
 * webhook de Mercado Pago) pasa por acá y se reenvía server-to-server a
 * BACKEND_INTERNAL_URL. Así el navegador y Mercado Pago solo necesitan
 * conocer UN dominio público (el túnel del frontend) — no hace falta CORS
 * ni un segundo túnel para el backend.
 */
function backendBaseUrl(): string {
  return (process.env.BACKEND_INTERNAL_URL ?? "http://localhost:3001").replace(/\/+$/, "");
}

async function proxy(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;
  const forwardPath = path.join("/");
  const targetUrl = `${backendBaseUrl()}/${forwardPath}${request.nextUrl.search}`;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
    });

    return new NextResponse(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "No se pudo conectar con el backend.",
      },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
export const HEAD = proxy;
