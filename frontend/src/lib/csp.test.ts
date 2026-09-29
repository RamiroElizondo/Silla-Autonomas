import { describe, expect, it } from "vitest";
import { construirCsp } from "./csp";

describe("construirCsp", () => {
  it("producción: NO incluye 'unsafe-eval' en script-src", () => {
    const csp = construirCsp(false);
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("dev: incluye 'unsafe-eval' en script-src (lo necesita el HMR de next dev)", () => {
    const csp = construirCsp(true);
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'unsafe-eval'");
  });

  it("dev y producción: mantienen el resto de las directivas sin cambios", () => {
    const cspProd = construirCsp(false);
    const cspDev = construirCsp(true);
    const sinScriptSrc = (csp: string) =>
      csp.split("; ").filter((d) => !d.startsWith("script-src")).join("; ");
    expect(sinScriptSrc(cspProd)).toBe(sinScriptSrc(cspDev));
  });

  it("mantiene frame-ancestors 'none' (ninguna vista se embebe en iframe)", () => {
    expect(construirCsp(false)).toContain("frame-ancestors 'none'");
    expect(construirCsp(true)).toContain("frame-ancestors 'none'");
  });
});

describe("construirCsp con nonce", () => {
  it("agrega nonce y strict-dynamic a script-src", () => {
    const csp = construirCsp(false, "abc123");
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).toContain("'nonce-abc123'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("unsafe-inline");
  });
});
