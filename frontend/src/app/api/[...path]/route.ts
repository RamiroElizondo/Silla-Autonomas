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
 *
 * Además, para `/api/admin/*`, este proxy es el único lugar que sabe del
 * JWT: lo guarda en una cookie httpOnly (nunca llega al JS del navegador) y
 * lo traduce a `Authorization: Bearer` al reenviar al backend. Ver
 * `ADMIN_COOKIE` más abajo.
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

/** Nombre de la cookie de sesión del panel admin (ver Bloque A del hardening). */
const ADMIN_COOKIE = "admin_session";
/** Mismo Path que se le pone a la cookie: el navegador no la manda a ninguna otra ruta. */
const ADMIN_COOKIE_PATH = "/api/admin";
/**
 * Protección CSRF liviana (además de SameSite=Strict, que ya alcanza como
 * base): un <form> cross-site no puede agregar headers custom, así que
 * cualquier POST/PATCH/etc. a `/api/admin/*` sin este header se rechaza.
 * Lo manda `frontend/src/lib/api.ts` en toda request no-GET a `/admin/*`.
 */
const CSRF_HEADER = "x-requested-with";
const CSRF_HEADER_VALOR = "sillas-admin";

function esMetodoDeEscritura(metodo: string): boolean {
  return metodo !== "GET" && metodo !== "HEAD" && metodo !== "OPTIONS";
}

/**
 * Segundos de vida de la cookie de sesión. Tiene que coincidir con
 * `JWT_EXPIRES_IN` del backend (default 8h): si la cookie dura más, el
 * navegador la sigue mandando después de que el JWT ya expiró (inofensivo,
 * el backend igual la rechaza); si dura menos, el usuario queda deslogueado
 * antes de que el token venciera.
 */
function sesionMaxAgeSegundos(): number {
  const raw = Number(process.env.ADMIN_SESSION_MAX_AGE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 8 * 60 * 60;
}

/** Secure solo si la request llegó por HTTPS — así la cookie también funciona en dev por http. */
function esHttps(request: NextRequest): boolean {
  const proto = request.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0]!.trim() === "https";
  return request.nextUrl.protocol === "https:";
}

function cookieOptions(request: NextRequest, maxAge: number) {
  return {
    httpOnly: true,
    secure: esHttps(request),
    sameSite: "strict" as const,
    path: ADMIN_COOKIE_PATH,
    maxAge,
  };
}

async function proxy(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;
  const forwardPath = path.join("/");
  const targetUrl = `${backendBaseUrl()}/${forwardPath}${request.nextUrl.search}`;

  const esAdmin = path[0] === "admin";
  const esLogin = esAdmin && path[1] === "auth" && path[2] === "login";
  const esLogout = esAdmin && path[1] === "auth" && path[2] === "logout";

  // CSRF (ver CSRF_HEADER más arriba): se exige en TODO no-GET a /admin/*,
  // login incluido — antes de tocar el backend.
  if (esAdmin && esMetodoDeEscritura(request.method)) {
    if (request.headers.get(CSRF_HEADER) !== CSRF_HEADER_VALOR) {
      return NextResponse.json(
        { message: "Falta encabezado requerido" },
        { status: 403 },
      );
    }
  }

  // Se calcula ANTES de tocar los headers reenviados: resolverIpCliente lee
  // los headers originales de la request del cliente.
  const ipCliente = resolverIpCliente(request.headers);

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  // El backend no usa cookies para nada: nunca reenviarlas (evita que la
  // cookie de sesión admin viaje de más, y evita depender por accidente de
  // cualquier otra cookie que el navegador mande).
  headers.delete("cookie");
  for (const nombre of HEADERS_DE_IP_A_BORRAR) headers.delete(nombre);

  if (ipCliente) headers.set("x-client-ip", ipCliente);
  // Le prueba al backend que este `x-client-ip` lo puso este proxy y no un
  // cliente cualquiera. Si no está configurado, no se manda: el backend cae
  // a la IP del socket (ver resolverIpConfiable).
  const proxySecret = process.env.PROXY_SHARED_SECRET;
  if (proxySecret) headers.set("x-proxy-secret", proxySecret);

  // Sesión admin: el navegador ya no tiene el JWT (vive solo en la cookie
  // httpOnly), así que acá es donde se traduce cookie → Bearer. En el login
  // todavía no hay cookie (se está por crear con esta misma respuesta), así
  // que no hay nada que traducir.
  if (esAdmin) {
    headers.delete("authorization");
    if (!esLogin) {
      const sesion = request.cookies.get(ADMIN_COOKIE)?.value;
      if (sesion) headers.set("authorization", `Bearer ${sesion}`);
    }
  }

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

    if (esLogin && response.ok) {
      // El backend devuelve { token }; acá se lo saca del body (nunca llega
      // al navegador) y se guarda en la cookie httpOnly.
      let token: unknown;
      try {
        token = (await response.json())?.token;
      } catch {
        token = undefined;
      }
      const salida = NextResponse.json({ ok: true }, { status: response.status });
      if (typeof token === "string" && token) {
        salida.cookies.set(ADMIN_COOKIE, token, cookieOptions(request, sesionMaxAgeSegundos()));
      }
      return salida;
    }

    if (esLogout) {
      // Se borra la cookie pase lo que pase: si el backend falló en
      // invalidar el tokenVersion (por ejemplo porque el token ya había
      // expirado), no tiene sentido dejarle al navegador una cookie que de
      // todos modos ya no sirve.
      const salida = new NextResponse(response.body, {
        status: response.status,
        headers: response.headers,
      });
      salida.cookies.set(ADMIN_COOKIE, "", cookieOptions(request, 0));
      return salida;
    }

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
