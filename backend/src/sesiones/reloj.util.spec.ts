import { calcularReloj } from './reloj.util';

describe('calcularReloj — segundosParaLiberar (lo que ve quien espera)', () => {
  const ahora = Date.parse('2026-10-13T12:00:00.000Z');
  const base = { duracionMin: 5, pausaRetornoSeg: 10, retornoSeg: 40, salidaHasta: null };

  it('durante el masaje suma lo que falta más la pausa y el retorno', () => {
    const r = calcularReloj(
      { ...base, estado: 'ACTIVA', finProgramado: new Date(ahora + 60_000) },
      ahora,
    );
    expect(r.segundosRestantes).toBe(60);
    expect(r.segundosParaLiberar).toBe(60 + 10 + 40);
  });

  it('en la gracia el reloj del cliente queda quieto, pero el de quien espera corre', () => {
    // 5 min contratados + 20 s de gracia que todavía no se consumieron.
    const r = calcularReloj(
      { ...base, estado: 'ACTIVA', finProgramado: new Date(ahora + 320_000) },
      ahora,
    );
    expect(r.fase).toBe('GRACIA');
    expect(r.segundosRestantes).toBe(300);
    expect(r.segundosParaLiberar).toBe(320 + 50);
  });

  it('sin pulso de retorno no hay fase de salida: se libera al terminar el masaje', () => {
    const r = calcularReloj(
      { ...base, retornoSeg: 0, estado: 'ACTIVA', finProgramado: new Date(ahora + 60_000) },
      ahora,
    );
    expect(r.segundosParaLiberar).toBe(60);
  });

  it('empalma con la salida: al terminar el masaje sigue desde pausa + retorno, sin saltar', () => {
    const finMasaje = calcularReloj(
      { ...base, estado: 'ACTIVA', finProgramado: new Date(ahora) },
      ahora,
    );
    const inicioSalida = calcularReloj(
      { ...base, estado: 'SALIDA', finProgramado: new Date(ahora), salidaHasta: new Date(ahora + 50_000) },
      ahora,
    );
    expect(finMasaje.segundosParaLiberar).toBe(50);
    expect(inicioSalida.segundosParaLiberar).toBe(50);
  });
});
