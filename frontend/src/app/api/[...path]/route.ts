import { NextRequest, NextResponse } from "next/server";
import { resolverIpCliente } from "@/lib/resolver-ip-cliente";

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
  return (process.env.BACKEND_INTERNAL_URL ?? "http://localhost:3002").replace(/\/+$/, "");
}

// Headers de IP que un cliente puede mandar libremente pegándole a este
// proxy. Se borran SIEMPRE de lo que se reenvía al backend: lo único que
// vale es `x-client-ip`, que este proxy calcula acá abajo con
// `resolverIpCliente` (que a su vez solo confía en `cf-connecting-ip`).
const HEADERS_DE_IP_A_BORRAR = [
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "x-client-ip",
  "x-proxy-secret",
];

async function proxy(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;
  const forwardPath = path.join("/");
  const targetUrl = `${backendBaseUrl()}/${forwardPath}${request.nextUrl.search}`;

  // Se calcula ANTES de tocar los headers reenviados: resolverIpCliente lee
  // los headers originales de la request del cliente.
  const ipCliente = resolverIpCliente(request.headers);

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  for (const nombre of HEADERS_DE_IP_A_BORRAR) headers.delete(nombre);

  if (ipCliente) headers.set("x-client-ip", ipCliente);
  // Le prueba al backend que este `x-client-ip` lo puso este proxy y no un
  // cliente cualquiera. Si no está configurado, no se manda: el backend cae
  // a la IP del socket (ver resolverIpConfiable).
  const proxySecret = process.env.PROXY_SHARED_SECRET;
  if (proxySecret) headers.set("x-proxy-secret", proxySecret);

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
