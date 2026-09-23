import { HeartbeatService } from './heartbeat.service';
import { DispositivoCloud } from './shelly.service';

/**
 * Silla mínima para `chequear()`: solo lee `id`, `nombre`, `deviceIdShelly`
 * y `estado` de cada fila.
 */
function crearSilla(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 's1',
    nombre: 'Silla 1',
    deviceIdShelly: 'e4b063f1a2c3',
    estado: 'EN_USO',
    ...overrides,
  };
}

function crearDispositivo(overrides: Partial<DispositivoCloud> = {}): DispositivoCloud {
  return {
    deviceId: 'e4b063f1a2c3',
    online: true,
    modelo: 'Plus 1PM',
    generacion: 'G3',
    releEncendido: true,
    potenciaW: null,
    temperaturaC: 40,
    midePotencia: true,
    initialState: 'off',
    ...overrides,
  };
}

function crearPrismaMock(sillas: ReturnType<typeof crearSilla>[]) {
  return { silla: { findMany: jest.fn().mockResolvedValue(sillas) } } as any;
}

function crearShellyMock(dispositivos: DispositivoCloud[]) {
  return { listarDispositivos: jest.fn().mockResolvedValue(dispositivos) } as any;
}

/**
 * Bloque D (hallazgo BAJO): confirma que la alerta de "relé ON con 0W"
 * distingue entre un device que directamente NO mide potencia (potenciaW
 * null — Shelly Plus 1 / 1 Gen3, sin `apower`) y uno que sí mide y reporta
 * 0W de verdad (posible silla desenchufada/rota). Alertar en el primer caso
 * sería un falso positivo permanente para todo el hardware sin medición.
 */
describe('HeartbeatService — alerta de relé ON con 0W', () => {
  async function chequearYObtenerAlertas(potenciaW: number | null) {
    const silla = crearSilla();
    const prisma = crearPrismaMock([silla]);
    const shelly = crearShellyMock([
      crearDispositivo({ deviceId: silla.deviceIdShelly, releEncendido: true, potenciaW }),
    ]);
    const heartbeat = new HeartbeatService(prisma, shelly);

    await heartbeat.chequear();
    return heartbeat.getSaludDe(silla.id)?.alertas ?? [];
  }

  it('relé ON + potenciaW 0 (mide y da 0W real): alerta', async () => {
    const alertas = await chequearYObtenerAlertas(0);
    expect(alertas).toContain('Relé encendido pero consumo 0W: silla desenchufada o con falla');
  });

  it('relé ON + potenciaW null (device sin medición de potencia): NO alerta', async () => {
    const alertas = await chequearYObtenerAlertas(null);
    expect(alertas).not.toContain(
      'Relé encendido pero consumo 0W: silla desenchufada o con falla',
    );
  });

  it('relé ON + potenciaW 5 (consumo normal): NO alerta', async () => {
    const alertas = await chequearYObtenerAlertas(5);
    expect(alertas).not.toContain(
      'Relé encendido pero consumo 0W: silla desenchufada o con falla',
    );
  });
});
