import { HttpException } from '@nestjs/common';
import { FallosCanjeService } from './fallos-canje.service';
import { MAX_FALLOS_CANJE } from '../common/throttle.config';

describe('FallosCanjeService (Hallazgo ALTO 3)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('no bloquea una IP sin fallos previos', () => {
    const servicio = new FallosCanjeService();
    expect(() => servicio.verificarNoBloqueado('1.2.3.4')).not.toThrow();
  });

  it(`bloquea al llegar a ${MAX_FALLOS_CANJE} fallos en la ventana`, () => {
    const servicio = new FallosCanjeService();
    for (let i = 0; i < MAX_FALLOS_CANJE; i++) {
      servicio.registrarFallo('1.2.3.4');
    }
    expect(() => servicio.verificarNoBloqueado('1.2.3.4')).toThrow(HttpException);
  });

  it(`con ${MAX_FALLOS_CANJE - 1} fallos todavía no bloquea`, () => {
    const servicio = new FallosCanjeService();
    for (let i = 0; i < MAX_FALLOS_CANJE - 1; i++) {
      servicio.registrarFallo('1.2.3.4');
    }
    expect(() => servicio.verificarNoBloqueado('1.2.3.4')).not.toThrow();
  });

  it('el bloqueo expira pasada 1 hora', () => {
    const servicio = new FallosCanjeService();
    for (let i = 0; i < MAX_FALLOS_CANJE; i++) {
      servicio.registrarFallo('1.2.3.4');
    }
    expect(() => servicio.verificarNoBloqueado('1.2.3.4')).toThrow(HttpException);

    jest.advanceTimersByTime(60 * 60_000 + 1);

    expect(() => servicio.verificarNoBloqueado('1.2.3.4')).not.toThrow();
  });

  it('cada IP tiene su propio contador (independientes)', () => {
    const servicio = new FallosCanjeService();
    for (let i = 0; i < MAX_FALLOS_CANJE; i++) {
      servicio.registrarFallo('1.2.3.4');
    }
    expect(() => servicio.verificarNoBloqueado('1.2.3.4')).toThrow(HttpException);
    expect(() => servicio.verificarNoBloqueado('5.6.7.8')).not.toThrow();
  });

  it('un éxito borra el historial de fallos de esa IP', () => {
    const servicio = new FallosCanjeService();
    for (let i = 0; i < MAX_FALLOS_CANJE - 1; i++) {
      servicio.registrarFallo('1.2.3.4');
    }
    servicio.registrarExito('1.2.3.4');
    // Si el éxito no limpiara, un fallo más alcanzaría el máximo.
    servicio.registrarFallo('1.2.3.4');
    expect(() => servicio.verificarNoBloqueado('1.2.3.4')).not.toThrow();
  });

  it('los fallos fuera de la ventana de 1h no cuentan para el bloqueo', () => {
    const servicio = new FallosCanjeService();
    for (let i = 0; i < MAX_FALLOS_CANJE - 1; i++) {
      servicio.registrarFallo('1.2.3.4');
    }
    jest.advanceTimersByTime(60 * 60_000 + 1);
    // Estos fallos viejos ya prescribieron; hace falta juntar el máximo de
    // nuevo, no alcanza con uno más.
    servicio.registrarFallo('1.2.3.4');
    expect(() => servicio.verificarNoBloqueado('1.2.3.4')).not.toThrow();
  });
});
