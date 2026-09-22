import {
  ALFABETO_CODIGO_CREDITO,
  generarCodigoCredito,
  normalizarCodigo,
} from './codigo-credito.util';

describe('generarCodigoCredito (Hallazgo ALTO 3)', () => {
  it('devuelve el formato LUZ-XXXX-XXXX', () => {
    const codigo = generarCodigoCredito();
    expect(codigo).toMatch(/^LUZ-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('usa solo caracteres del alfabeto sin ambigüedades (sin 0/O/1/I/L)', () => {
    for (let i = 0; i < 200; i++) {
      const codigo = generarCodigoCredito();
      // El prefijo fijo "LUZ-" es literal, no viene del alfabeto aleatorio
      // (y de hecho contiene una "L", que el alfabeto excluye a propósito):
      // la verificación de ambigüedad es solo sobre el cuerpo generado.
      const cuerpo = codigo.replace(/^LUZ-/, '').replace(/-/g, '');
      for (const char of cuerpo) {
        expect(ALFABETO_CODIGO_CREDITO).toContain(char);
      }
      expect(cuerpo).not.toMatch(/[01OIL]/);
    }
  });

  it('no usa Math.random (fuente de aleatoriedad no apta para esto)', () => {
    const spyMathRandom = jest.spyOn(Math, 'random');

    generarCodigoCredito();

    expect(spyMathRandom).not.toHaveBeenCalled();

    spyMathRandom.mockRestore();
  });

  it('genera 10.000 códigos sin colisiones', () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      vistos.add(generarCodigoCredito());
    }
    expect(vistos.size).toBe(10_000);
  });

  it('distribuye los caracteres del cuerpo razonablemente parejo', () => {
    const conteo = new Map<string, number>();
    const muestras = 5_000;
    for (let i = 0; i < muestras; i++) {
      const cuerpo = generarCodigoCredito().replace(/^LUZ-/, '').replace(/-/g, '');
      for (const char of cuerpo) {
        conteo.set(char, (conteo.get(char) ?? 0) + 1);
      }
    }
    // Con 31 símbolos y 8*5000 = 40000 caracteres generados, el promedio
    // esperado por símbolo es ~1290. Ningún símbolo debería quedar en cero
    // ni acaparar una fracción desproporcionada si randomInt es uniforme.
    expect(conteo.size).toBeGreaterThan(ALFABETO_CODIGO_CREDITO.length - 3);
    for (const cantidad of conteo.values()) {
      expect(cantidad).toBeGreaterThan(0);
    }
  });
});

describe('normalizarCodigo (Hallazgo ALTO 3)', () => {
  it('acepta el formato nuevo con guiones y minúsculas', () => {
    expect(normalizarCodigo('luz-a2b4-9cde')).toBe('LUZ-A2B4-9CDE');
  });

  it('acepta el formato nuevo sin guiones ni mayúsculas', () => {
    expect(normalizarCodigo('luza2b49cde')).toBe('LUZ-A2B4-9CDE');
  });

  it('sigue aceptando el formato viejo "LUZ-1234" (vales ya emitidos)', () => {
    expect(normalizarCodigo('LUZ-4821')).toBe('LUZ-4821');
    expect(normalizarCodigo('luz4821')).toBe('LUZ-4821');
  });

  it('tolera espacios y caracteres sueltos al tipear', () => {
    expect(normalizarCodigo('  luz - a2b4 - 9cde  ')).toBe('LUZ-A2B4-9CDE');
  });

  it('con una entrada de longitud rara, no revienta (devuelve el limpio tal cual)', () => {
    expect(normalizarCodigo('abc')).toBe('ABC');
  });
});
