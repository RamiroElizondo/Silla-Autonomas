import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

function req(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): NextRequest {
  return new NextRequest(`http://localhost:3003/api/${path}`, {
    method,
    headers: opts.headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

function params(path: string): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path: path.split("/") }) };
}

const handler = (method: string) => (method === "GET" ? GET : POST);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("proxy /api/[...path] — sesión admin (Bloque A)", () => {
  it("login exitoso: setea la cookie httpOnly/Secure=false en http/SameSite=Strict y no expone el token en el body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ token: "jwt.de.prueba" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const request = req("POST", "admin/auth/login", {
      headers: { "x-requested-with": "sillas-admin", "content-type": "application/json" },
      body: { email: "a@a.com", password: "12345678" },
    });
    const res = await POST(request, params("admin/auth/login"));

    const cuerpo = await res.json();
    expect(cuerpo).not.toHaveProperty("token");
    expect(cuerpo.ok).toBe(true);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("admin_session=jwt.de.prueba");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/admin/i);
    expect(setCookie).not.toMatch(/Secure/i); // request de prueba es http, no https
  });

  it("login por https: la cookie sale con Secure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ token: "jwt.de.prueba" }), { status: 201 }),
      ),
    );
    const request = req("POST", "admin/auth/login", {
      headers: {
        "x-requested-with": "sillas-admin",
        "x-forwarded-proto": "https",
      },
      body: { email: "a@a.com", password: "12345678" },
    });
    const res = await POST(request, params("admin/auth/login"));
    expect(res.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("rechaza con 403 un POST a /admin/* sin el header X-Requested-With, y no llega a pegarle al backend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = req("POST", "admin/sillas", { body: { nombre: "x" } });
    const res = await POST(request, params("admin/sillas"));

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un GET a /admin/* no necesita X-Requested-With", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const request = req("GET", "admin/sillas");
    const res = await GET(request, params("admin/sillas"));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("traduce la cookie admin_session a Authorization: Bearer al reenviar al backend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const request = req("GET", "admin/sillas", {
      headers: { cookie: "admin_session=jwt.viejo" },
    });
    await GET(request, params("admin/sillas"));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer jwt.viejo");
    // La cookie del navegador nunca se reenvía tal cual al backend.
    expect(headers.get("cookie")).toBeNull();
  });

  it("sin cookie, no manda Authorization (y no reenvía uno que el cliente haya mandado a mano)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const request = req("GET", "admin/sillas", {
      headers: { authorization: "Bearer lo-que-sea" },
    });
    await GET(request, params("admin/sillas"));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("logout: borra la cookie (Max-Age=0) incluso si el backend devuelve error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    const request = req("POST", "admin/auth/logout", {
      headers: { "x-requested-with": "sillas-admin", cookie: "admin_session=jwt.viejo" },
    });
    const res = await POST(request, params("admin/auth/logout"));

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("admin_session=;");
    expect(setCookie).toMatch(/Max-Age=0/i);
  });

  it("rutas no-admin no exigen X-Requested-With ni tocan cookies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const request = req("POST", "sillas/abc/checkout", { body: {} });
    const res = await POST(request, params("sillas/abc/checkout"));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
