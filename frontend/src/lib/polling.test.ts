import { describe, expect, it, vi } from "vitest";
import { debeSondearAhora, parsearRetryAfter, proximoRetrasoMs } from "./polling";

describe("debeSondearAhora", () => {
  it("visible: siempre sondea, pause en oculto o no", () => {
    expect(debeSondearAhora({ oculto: false, pausarEnOculto: true })).toBe(true);
    expect(debeSondearAhora({ oculto: false, pausarEnOculto: false })).toBe(true);
  });

  it("oculto + pausarEnOculto: no sondea", () => {
    expect(debeSondearAhora({ oculto: true, pausarEnOculto: true })).toBe(false);
  });

  it("oculto + NO pausarEnOculto (pantalla TV): sigue sondeando", () => {
    expect(debeSondearAhora({ oculto: true, pausarEnOculto: false })).toBe(true);
  });
});

describe("parsearRetryAfter", () => {
  it("header ausente: null", () => {
    expect(parsearRetryAfter(null)).toBeNull();
  });

  it("header vacío: null", () => {
    expect(parsearRetryAfter("")).toBeNull();
    expect(parsearRetryAfter("   ")).toBeNull();
  });

  it("segundos delta: los convierte a milisegundos", () => {
    expect(parsearRetryAfter("120")).toBe(120_000);
    expect(parsearRetryAfter("0")).toBe(0);
    expect(parsearRetryAfter("5")).toBe(5000);
  });

  it("fecha HTTP: milisegundos desde ahora hasta esa fecha", () => {
    vi.useFakeTimers();
    const ahora = new Date("2026-01-01T00:00:00.000Z").getTime();
    vi.setSystemTime(ahora);
    try {
      const fechaFutura = new Date(ahora + 30_000).toUTCString();
      expect(parsearRetryAfter(fechaFutura)).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fecha HTTP ya pasada: nunca negativo (se recorta a 0)", () => {
    vi.useFakeTimers();
    const ahora = new Date("2026-01-01T00:00:00.000Z").getTime();
    vi.setSystemTime(ahora);
    try {
      const fechaPasada = new Date(ahora - 30_000).toUTCString();
      expect(parsearRetryAfter(fechaPasada)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("valor no parseable: null", () => {
    expect(parsearRetryAfter("no-es-ni-numero-ni-fecha")).toBeNull();
  });
});

describe("proximoRetrasoMs", () => {
  it("sin retryAfterMs: usa el intervalo base", () => {
    expect(proximoRetrasoMs({ intervaloBaseMs: 5000, retryAfterMs: null })).toBe(5000);
  });

  it("retryAfterMs menor que el intervalo base: igual usa el intervalo base", () => {
    expect(proximoRetrasoMs({ intervaloBaseMs: 5000, retryAfterMs: 1000 })).toBe(5000);
  });

  it("retryAfterMs mayor que el intervalo base: usa el retryAfterMs", () => {
    expect(proximoRetrasoMs({ intervaloBaseMs: 5000, retryAfterMs: 60_000 })).toBe(60_000);
  });

  it("retryAfterMs igual al intervalo base: da lo mismo cuál devuelve", () => {
    expect(proximoRetrasoMs({ intervaloBaseMs: 5000, retryAfterMs: 5000 })).toBe(5000);
  });
});
