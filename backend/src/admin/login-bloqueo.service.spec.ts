import { LoginBloqueoService } from './login-bloqueo.service';

describe('LoginBloqueoService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('no bloquea un email sin intentos previos', () => {
    const s = new LoginBloqueoService();
    expect(s.estaBloqueado('a@a.com')).toBe(false);
  });

  it('bloquea tras 10 fallos dentro de la ventana', () => {
    const s = new LoginBloqueoService();
    for (let i = 0; i < 9; i++) s.registrarFallo('a@a.com');
    expect(s.estaBloqueado('a@a.com')).toBe(false);

    s.registrarFallo('a@a.com'); // 10º fallo
    expect(s.estaBloqueado('a@a.com')).toBe(true);
  });

  it('cuenta también los fallos contra un email que nunca existió (no debe filtrar existencia)', () => {
    const s = new LoginBloqueoService();
    for (let i = 0; i < 10; i++) s.registrarFallo('no-existe@a.com');
    expect(s.estaBloqueado('no-existe@a.com')).toBe(true);
  });

  it('normaliza el email (mayúsculas / espacios) al contar y consultar', () => {
    const s = new LoginBloqueoService();
    for (let i = 0; i < 10; i++) s.registrarFallo('  A@A.com ');
    expect(s.estaBloqueado('a@a.com')).toBe(true);
  });

  it('un login exitoso limpia el historial de fallos', () => {
    const s = new LoginBloqueoService();
    for (let i = 0; i < 9; i++) s.registrarFallo('a@a.com');
    s.registrarExito('a@a.com');
    s.registrarFallo('a@a.com');
    expect(s.estaBloqueado('a@a.com')).toBe(false);
  });

  it('se desbloquea al pasar el tiempo de bloqueo', () => {
    const s = new LoginBloqueoService();
    for (let i = 0; i < 10; i++) s.registrarFallo('a@a.com');
    expect(s.estaBloqueado('a@a.com')).toBe(true);

    jest.advanceTimersByTime(15 * 60_000 - 1);
    expect(s.estaBloqueado('a@a.com')).toBe(true);

    jest.advanceTimersByTime(2);
    expect(s.estaBloqueado('a@a.com')).toBe(false);
  });

  it('una ventana de fallos vieja (>15 min) no acumula con fallos nuevos', () => {
    const s = new LoginBloqueoService();
    for (let i = 0; i < 9; i++) s.registrarFallo('a@a.com');

    jest.advanceTimersByTime(15 * 60_000 + 1);

    // La ventana anterior venció: este es un fallo "1" de una ventana nueva,
    // no el 10º de la vieja.
    s.registrarFallo('a@a.com');
    expect(s.estaBloqueado('a@a.com')).toBe(false);
  });

  it('cada email tiene su propio contador', () => {
    const s = new LoginBloqueoService();
    for (let i = 0; i < 10; i++) s.registrarFallo('a@a.com');
    expect(s.estaBloqueado('a@a.com')).toBe(true);
    expect(s.estaBloqueado('b@b.com')).toBe(false);
  });
});
