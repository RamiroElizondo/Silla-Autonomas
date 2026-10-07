import { EnergiaService } from './energia.service';
import { UMBRAL_CORTE_SEG, MAX_ESPERA_ENERGIA_SEG } from './sesiones.service';

function crearServicio() {
  const prisma: any = {
    sesion: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const sesiones: any = {
    cerrarPorCorte: jest.fn().mockResolvedValue(null),
    registrarCorte: jest.fn().mockResolvedValue(true),
    reanudarTrasCorte: jest.fn().mockResolvedValue(true),
    vencerEsperaEnergia: jest.fn().mockResolvedValue(null),
    activarSesion: jest.fn().mockResolvedValue(undefined),
  };
  const heartbeat: any = {
    getSalud: jest.fn().mockReturnValue([]),
  };
  const shelly: any = {
    setRele: jest.fn().mockResolvedValue(undefined),
  };

  const servicio = new EnergiaService(prisma, sesiones, heartbeat, shelly);
  return { servicio, prisma, sesiones, heartbeat, shelly };
}

function salud(overrides: Partial<{
  sillaId: string;
  nombre: string;
  deviceId: string;
  online: boolean;
  releEncendido: boolean | null;
  potenciaW: number | null;
  temperaturaC: number | null;
  alertas: string[];
  ultimoChequeo: Date;
  ultimoOnline: Date | null;
}> = {}) {
  return {
    sillaId: 'silla-1',
    nombre: 'Silla 1',
    deviceId: 'dev-1',
    online: true,
    releEncendido: true,
    potenciaW: 50,
    temperaturaC: 40,
    alertas: [],
    ultimoChequeo: new Date(),
    ultimoOnline: null,
    ...overrides,
  };
}

const sesionActivaBase = {
  id: 'sesion-1',
  estado: 'ACTIVA' as const,
  inicio: new Date(Date.now() - 10 * 60_000),
  interrumpidaEn: null as Date | null,
  pagadaEn: null as Date | null,
  creadaEn: new Date(Date.now() - 10 * 60_000),
  sillaId: 'silla-1',
  silla: { nombre: 'Silla 1' },
};

const sesionEsperandoBase = {
  id: 'sesion-2',
  estado: 'ESPERANDO_ENERGIA' as const,
  inicio: null as Date | null,
  interrumpidaEn: null as Date | null,
  pagadaEn: new Date(Date.now() - 60_000),
  creadaEn: new Date(Date.now() - 60_000),
  sillaId: 'silla-1',
  silla: { nombre: 'Silla 1' },
};

describe('EnergiaService.revisar — reentrancia', () => {
  it('una segunda llamada mientras la primera sigue en curso es un no-op', async () => {
    const { servicio, prisma } = crearServicio();
    let liberar!: () => void;
    const pendiente = new Promise<any[]>((resolve) => {
      liberar = () => resolve([]);
    });
    prisma.sesion.findMany.mockReturnValueOnce(pendiente);

    const primera = servicio.revisar();
    const segunda = servicio.revisar();

    expect(prisma.sesion.findMany).toHaveBeenCalledTimes(1);

    liberar();
    await primera;
    await segunda;

    expect(prisma.sesion.findMany).toHaveBeenCalledTimes(1);
  });

  it('tras terminar una pasada, la siguiente llamada a revisar() sí corre', async () => {
    const { servicio, prisma } = crearServicio();
    await servicio.revisar();
    await servicio.revisar();
    expect(prisma.sesion.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('EnergiaService.revisar — red de seguridad y frescura del heartbeat', () => {
  it('cierra por corte una sesión con interrumpidaEn viejo (>= 2x umbral) aunque no haya heartbeat', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([]); // sin heartbeat en absoluto
    const sesion = {
      ...sesionActivaBase,
      interrumpidaEn: new Date(Date.now() - (UMBRAL_CORTE_SEG * 2 + 5) * 1000),
    };
    prisma.sesion.findMany.mockResolvedValueOnce([sesion]);

    await servicio.revisar();

    expect(sesiones.cerrarPorCorte).toHaveBeenCalledWith('sesion-1');
    expect(sesiones.registrarCorte).not.toHaveBeenCalled();
  });

  it('sin heartbeat para la silla y sin red de seguridad aplicable: no hace nada', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([]);
    prisma.sesion.findMany.mockResolvedValueOnce([{ ...sesionActivaBase }]);

    await servicio.revisar();

    expect(sesiones.registrarCorte).not.toHaveBeenCalled();
    expect(sesiones.cerrarPorCorte).not.toHaveBeenCalled();
  });

  it('heartbeat vieja (> FRESCURA_MAX_MS) para la silla: no hace nada', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([
      salud({ ultimoChequeo: new Date(Date.now() - (3 * 60_000 + 1000)) }),
    ]);
    prisma.sesion.findMany.mockResolvedValueOnce([{ ...sesionActivaBase }]);

    await servicio.revisar();

    expect(sesiones.registrarCorte).not.toHaveBeenCalled();
    expect(sesiones.cerrarPorCorte).not.toHaveBeenCalled();
  });
});

describe('EnergiaService.revisar — ESPERANDO_ENERGIA', () => {
  it('timeout vencido: llama a vencerEsperaEnergia sin importar online/offline', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([salud({ online: false })]);
    const sesion = {
      ...sesionEsperandoBase,
      pagadaEn: new Date(Date.now() - (MAX_ESPERA_ENERGIA_SEG + 5) * 1000),
    };
    prisma.sesion.findMany.mockResolvedValueOnce([sesion]);

    await servicio.revisar();

    expect(sesiones.vencerEsperaEnergia).toHaveBeenCalledWith('sesion-2');
    expect(sesiones.activarSesion).not.toHaveBeenCalled();
  });

  it('usa creadaEn cuando pagadaEn es null para calcular la espera', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([salud({ online: false })]);
    const sesion = {
      ...sesionEsperandoBase,
      pagadaEn: null,
      creadaEn: new Date(Date.now() - (MAX_ESPERA_ENERGIA_SEG + 5) * 1000),
    };
    prisma.sesion.findMany.mockResolvedValueOnce([sesion]);

    await servicio.revisar();

    expect(sesiones.vencerEsperaEnergia).toHaveBeenCalledWith('sesion-2');
  });

  it('sin timeout y offline: no hace nada, sigue esperando', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([salud({ online: false })]);
    prisma.sesion.findMany.mockResolvedValueOnce([{ ...sesionEsperandoBase }]);

    await servicio.revisar();

    expect(sesiones.vencerEsperaEnergia).not.toHaveBeenCalled();
    expect(sesiones.activarSesion).not.toHaveBeenCalled();
  });

  it('sin timeout y online: activa la sesión', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([salud({ online: true })]);
    prisma.sesion.findMany.mockResolvedValueOnce([{ ...sesionEsperandoBase }]);

    await servicio.revisar();

    expect(sesiones.activarSesion).toHaveBeenCalledWith('sesion-2');
    expect(sesiones.vencerEsperaEnergia).not.toHaveBeenCalled();
  });

  it('activarSesion que tira excepción: se loguea como warning y no revienta revisar()', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([salud({ online: true })]);
    prisma.sesion.findMany.mockResolvedValueOnce([{ ...sesionEsperandoBase }]);
    sesiones.activarSesion.mockRejectedValueOnce(new Error('boom'));
    const warnSpy = jest.spyOn((servicio as any).logger, 'warn').mockImplementation(() => {});

    await expect(servicio.revisar()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('EnergiaService.revisar — ACTIVA, cae la energía', () => {
  it('recién se cae (sin interrumpidaEn previo): registra el corte', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    const s = salud({ online: false, ultimoChequeo: new Date() });
    heartbeat.getSalud.mockReturnValue([s]);
    prisma.sesion.findMany.mockResolvedValueOnce([{ ...sesionActivaBase, interrumpidaEn: null }]);

    await servicio.revisar();

    expect(sesiones.registrarCorte).toHaveBeenCalledWith('sesion-1', s.ultimoChequeo);
    expect(sesiones.cerrarPorCorte).not.toHaveBeenCalled();
  });

  it('fecha el corte en el último chequeo online, no en el que lo detecta', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    const ultimoOnline = new Date(Date.now() - 90_000);
    const s = salud({ online: false, ultimoChequeo: new Date(), ultimoOnline });
    heartbeat.getSalud.mockReturnValue([s]);
    prisma.sesion.findMany.mockResolvedValueOnce([{ ...sesionActivaBase, interrumpidaEn: null }]);

    await servicio.revisar();

    expect(sesiones.registrarCorte).toHaveBeenCalledWith('sesion-1', ultimoOnline);
  });

  it('nunca fecha el corte antes del inicio de la sesión', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    const inicio = new Date(Date.now() - 2 * 60_000);
    const s = salud({
      online: false,
      ultimoChequeo: new Date(),
      ultimoOnline: new Date(inicio.getTime() - 20_000),
    });
    heartbeat.getSalud.mockReturnValue([s]);
    prisma.sesion.findMany.mockResolvedValueOnce([
      { ...sesionActivaBase, inicio, interrumpidaEn: null },
    ]);

    await servicio.revisar();

    expect(sesiones.registrarCorte).toHaveBeenCalledWith('sesion-1', inicio);
  });

  it('sigue caída bajo el umbral: no hace nada más', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([salud({ online: false })]);
    const sesion = {
      ...sesionActivaBase,
      interrumpidaEn: new Date(Date.now() - (UMBRAL_CORTE_SEG - 30) * 1000),
    };
    prisma.sesion.findMany.mockResolvedValueOnce([sesion]);

    await servicio.revisar();

    expect(sesiones.cerrarPorCorte).not.toHaveBeenCalled();
    expect(sesiones.registrarCorte).not.toHaveBeenCalled();
  });

  it('sigue caída y ya pasó el umbral: cierra por corte', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([salud({ online: false })]);
    const sesion = {
      ...sesionActivaBase,
      interrumpidaEn: new Date(Date.now() - (UMBRAL_CORTE_SEG + 5) * 1000),
    };
    prisma.sesion.findMany.mockResolvedValueOnce([sesion]);

    await servicio.revisar();

    expect(sesiones.cerrarPorCorte).toHaveBeenCalledWith('sesion-1');
    expect(sesiones.registrarCorte).not.toHaveBeenCalled();
  });
});

describe('EnergiaService.revisar — ACTIVA, vuelve la energía', () => {
  it('vuelve online con interrumpidaEn bajo el umbral: reanuda', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([salud({ online: true })]);
    const sesion = {
      ...sesionActivaBase,
      interrumpidaEn: new Date(Date.now() - (UMBRAL_CORTE_SEG - 30) * 1000),
    };
    prisma.sesion.findMany.mockResolvedValueOnce([sesion]);

    await servicio.revisar();

    expect(sesiones.reanudarTrasCorte).toHaveBeenCalledWith('sesion-1');
    expect(sesiones.cerrarPorCorte).not.toHaveBeenCalled();
  });

  it('reanudarTrasCorte tira excepción: se loguea como warning y no revienta', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([salud({ online: true })]);
    const sesion = {
      ...sesionActivaBase,
      interrumpidaEn: new Date(Date.now() - (UMBRAL_CORTE_SEG - 30) * 1000),
    };
    prisma.sesion.findMany.mockResolvedValueOnce([sesion]);
    sesiones.reanudarTrasCorte.mockRejectedValueOnce(new Error('falló shelly'));
    const warnSpy = jest.spyOn((servicio as any).logger, 'warn').mockImplementation(() => {});

    await expect(servicio.revisar()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
  });

  it('vuelve online con interrumpidaEn sobre el umbral: cierra por corte en vez de reanudar', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([salud({ online: true })]);
    const sesion = {
      ...sesionActivaBase,
      interrumpidaEn: new Date(Date.now() - (UMBRAL_CORTE_SEG + 5) * 1000),
    };
    prisma.sesion.findMany.mockResolvedValueOnce([sesion]);

    await servicio.revisar();

    expect(sesiones.cerrarPorCorte).toHaveBeenCalledWith('sesion-1');
    expect(sesiones.reanudarTrasCorte).not.toHaveBeenCalled();
  });
});

describe('EnergiaService.revisar — corte breve no detectado como offline', () => {
  it('releEncendido=false + arranque ya asentado + registrarCorte truthy: registra y reanuda en el mismo tick', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    const inicio = new Date(Date.now() - 5 * 60_000);
    const s = salud({ online: true, releEncendido: false, ultimoChequeo: new Date() });
    heartbeat.getSalud.mockReturnValue([s]);
    const sesion = { ...sesionActivaBase, inicio, interrumpidaEn: null };
    prisma.sesion.findMany.mockResolvedValueOnce([sesion]);
    sesiones.registrarCorte.mockResolvedValueOnce(true);

    await servicio.revisar();

    expect(sesiones.registrarCorte).toHaveBeenCalledWith('sesion-1', s.ultimoChequeo);
    expect(sesiones.reanudarTrasCorte).toHaveBeenCalledWith('sesion-1');
  });

  it('releEncendido=false + arranque ya asentado + registrarCorte falsy: registra pero NO reanuda', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    const inicio = new Date(Date.now() - 5 * 60_000);
    const s = salud({ online: true, releEncendido: false, ultimoChequeo: new Date() });
    heartbeat.getSalud.mockReturnValue([s]);
    const sesion = { ...sesionActivaBase, inicio, interrumpidaEn: null };
    prisma.sesion.findMany.mockResolvedValueOnce([sesion]);
    sesiones.registrarCorte.mockResolvedValueOnce(false);

    await servicio.revisar();

    expect(sesiones.registrarCorte).toHaveBeenCalledWith('sesion-1', s.ultimoChequeo);
    expect(sesiones.reanudarTrasCorte).not.toHaveBeenCalled();
  });

  it('releEncendido=true: no dispara la rama de corte breve', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    const inicio = new Date(Date.now() - 5 * 60_000);
    heartbeat.getSalud.mockReturnValue([salud({ online: true, releEncendido: true })]);
    prisma.sesion.findMany.mockResolvedValueOnce([
      { ...sesionActivaBase, inicio, interrumpidaEn: null },
    ]);

    await servicio.revisar();

    expect(sesiones.registrarCorte).not.toHaveBeenCalled();
  });

  it('releEncendido=null: no dispara la rama de corte breve', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    const inicio = new Date(Date.now() - 5 * 60_000);
    heartbeat.getSalud.mockReturnValue([salud({ online: true, releEncendido: null })]);
    prisma.sesion.findMany.mockResolvedValueOnce([
      { ...sesionActivaBase, inicio, interrumpidaEn: null },
    ]);

    await servicio.revisar();

    expect(sesiones.registrarCorte).not.toHaveBeenCalled();
  });

  it('releEncendido=false pero arranque NO asentado (menos de 60s desde inicio): no dispara nada', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    const inicio = new Date(Date.now() - 10_000); // hace 10s, no asentado
    const s = salud({ online: true, releEncendido: false, ultimoChequeo: new Date() });
    heartbeat.getSalud.mockReturnValue([s]);
    prisma.sesion.findMany.mockResolvedValueOnce([
      { ...sesionActivaBase, inicio, interrumpidaEn: null },
    ]);

    await servicio.revisar();

    expect(sesiones.registrarCorte).not.toHaveBeenCalled();
  });
});

describe('EnergiaService — arranqueYaAsentado (a través de revisarSesionActiva)', () => {
  it('inicio null: no considera asentado, no dispara la rama de corte breve', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    const s = salud({ online: true, releEncendido: false, ultimoChequeo: new Date() });
    heartbeat.getSalud.mockReturnValue([s]);
    prisma.sesion.findMany.mockResolvedValueOnce([
      { ...sesionActivaBase, inicio: null, interrumpidaEn: null },
    ]);

    await servicio.revisar();

    expect(sesiones.registrarCorte).not.toHaveBeenCalled();
  });

  it('ultimoChequeo <= inicio: no considera asentado, no dispara la rama de corte breve', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    const inicio = new Date(Date.now() - 5 * 60_000);
    const s = salud({
      online: true,
      releEncendido: false,
      ultimoChequeo: new Date(inicio.getTime() - 1000), // anterior al inicio
    });
    heartbeat.getSalud.mockReturnValue([s]);
    prisma.sesion.findMany.mockResolvedValueOnce([
      { ...sesionActivaBase, inicio, interrumpidaEn: null },
    ]);

    await servicio.revisar();

    expect(sesiones.registrarCorte).not.toHaveBeenCalled();
  });

  it('mas de 60s desde inicio y ultimoChequeo posterior: sí se considera asentado', async () => {
    const { servicio, prisma, sesiones, heartbeat } = crearServicio();
    const inicio = new Date(Date.now() - 5 * 60_000);
    const s = salud({
      online: true,
      releEncendido: false,
      ultimoChequeo: new Date(), // posterior al inicio, y ya pasaron >60s desde inicio
    });
    heartbeat.getSalud.mockReturnValue([s]);
    prisma.sesion.findMany.mockResolvedValueOnce([
      { ...sesionActivaBase, inicio, interrumpidaEn: null },
    ]);
    sesiones.registrarCorte.mockResolvedValueOnce(false);

    await servicio.revisar();

    expect(sesiones.registrarCorte).toHaveBeenCalled();
  });
});

describe('EnergiaService.revisar — relés huérfanos', () => {
  it('no llama al segundo findMany si salud.size === 0', async () => {
    const { servicio, prisma, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([]);
    prisma.sesion.findMany.mockResolvedValueOnce([]);

    await servicio.revisar();

    expect(prisma.sesion.findMany).toHaveBeenCalledTimes(1);
  });

  it('primera detección de huérfano: solo guarda el timestamp, no apaga todavía', async () => {
    const { servicio, prisma, shelly, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([
      salud({ sillaId: 'silla-9', online: true, releEncendido: true }),
    ]);
    prisma.sesion.findMany
      .mockResolvedValueOnce([]) // sesiones activas/esperando
      .mockResolvedValueOnce([]); // sillas con sesión (ninguna)

    await servicio.revisar();

    expect(shelly.setRele).not.toHaveBeenCalled();
  });

  it('huérfano confirmado tras 60s: apaga el relé y limpia el mapa', async () => {
    const { servicio, prisma, shelly, heartbeat } = crearServicio();
    const nowSpy = jest.spyOn(Date, 'now');
    const t0 = Date.now();
    nowSpy.mockReturnValue(t0);

    heartbeat.getSalud.mockReturnValue([
      salud({
        sillaId: 'silla-9',
        deviceId: 'dev-9',
        online: true,
        releEncendido: true,
        ultimoChequeo: new Date(t0),
      }),
    ]);
    prisma.sesion.findMany.mockResolvedValue([]);

    await servicio.revisar(); // primera detección
    expect(shelly.setRele).not.toHaveBeenCalled();

    nowSpy.mockReturnValue(t0 + 61_000);
    heartbeat.getSalud.mockReturnValue([
      salud({
        sillaId: 'silla-9',
        deviceId: 'dev-9',
        online: true,
        releEncendido: true,
        ultimoChequeo: new Date(t0 + 61_000),
      }),
    ]);

    await servicio.revisar(); // confirmación

    expect(shelly.setRele).toHaveBeenCalledWith('dev-9', false);

    nowSpy.mockRestore();
  });

  it('deja de ser huérfano antes de confirmarse: limpia el mapa y no apaga', async () => {
    const { servicio, prisma, shelly, heartbeat } = crearServicio();
    const nowSpy = jest.spyOn(Date, 'now');
    const t0 = Date.now();
    nowSpy.mockReturnValue(t0);

    heartbeat.getSalud.mockReturnValue([
      salud({
        sillaId: 'silla-9',
        deviceId: 'dev-9',
        online: true,
        releEncendido: true,
        ultimoChequeo: new Date(t0),
      }),
    ]);
    prisma.sesion.findMany.mockResolvedValue([]);

    await servicio.revisar(); // primera detección, guarda timestamp

    // Ahora ya no es huérfano: pasó a tener una sesión detrás.
    nowSpy.mockReturnValue(t0 + 61_000);
    heartbeat.getSalud.mockReturnValue([
      salud({
        sillaId: 'silla-9',
        deviceId: 'dev-9',
        online: true,
        releEncendido: true,
        ultimoChequeo: new Date(t0 + 61_000),
      }),
    ]);
    prisma.sesion.findMany
      .mockResolvedValueOnce([]) // sesiones activas/esperando (loop principal)
      .mockResolvedValueOnce([{ sillaId: 'silla-9' }]); // ahora hay sesión en esa silla

    await servicio.revisar();

    expect(shelly.setRele).not.toHaveBeenCalled();

    // Si vuelve a quedar huérfano después, se cuenta como primera detección
    // de nuevo (el mapa se limpió), no como confirmación inmediata.
    nowSpy.mockReturnValue(t0 + 62_000);
    heartbeat.getSalud.mockReturnValue([
      salud({
        sillaId: 'silla-9',
        deviceId: 'dev-9',
        online: true,
        releEncendido: true,
        ultimoChequeo: new Date(t0 + 62_000),
      }),
    ]);
    prisma.sesion.findMany.mockResolvedValue([]);

    await servicio.revisar();

    expect(shelly.setRele).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  it('shelly.setRele tira excepción: se loguea, no crashea, y no limpia el mapa (reintenta el próximo tick)', async () => {
    const { servicio, prisma, shelly, heartbeat } = crearServicio();
    const nowSpy = jest.spyOn(Date, 'now');
    const t0 = Date.now();
    nowSpy.mockReturnValue(t0);

    heartbeat.getSalud.mockReturnValue([
      salud({
        sillaId: 'silla-9',
        deviceId: 'dev-9',
        online: true,
        releEncendido: true,
        ultimoChequeo: new Date(t0),
      }),
    ]);
    prisma.sesion.findMany.mockResolvedValue([]);

    await servicio.revisar(); // primera detección

    nowSpy.mockReturnValue(t0 + 61_000);
    heartbeat.getSalud.mockReturnValue([
      salud({
        sillaId: 'silla-9',
        deviceId: 'dev-9',
        online: true,
        releEncendido: true,
        ultimoChequeo: new Date(t0 + 61_000),
      }),
    ]);
    shelly.setRele.mockRejectedValueOnce(new Error('cloud caída'));
    const errorSpy = jest.spyOn((servicio as any).logger, 'error').mockImplementation(() => {});

    await servicio.revisar(); // intenta confirmar, falla

    expect(shelly.setRele).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();

    // El mapa NO se limpió: al reintentar (con Date.now sin avanzar más)
    // vuelve a intentar apagar en el próximo tick.
    shelly.setRele.mockResolvedValueOnce(undefined);
    await servicio.revisar();

    expect(shelly.setRele).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('silla que no está en salud.size>0 en absoluto pero hay otra huérfana: solo se evalúa la presente en salud', async () => {
    const { servicio, prisma, shelly, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([
      salud({ sillaId: 'silla-libre-sin-sesion', online: false, releEncendido: true }),
    ]);
    prisma.sesion.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await servicio.revisar();

    // online:false => no es huérfano (requiere online && releEncendido===true)
    expect(shelly.setRele).not.toHaveBeenCalled();
  });
});

describe('EnergiaService.revisar — excepción no capturada', () => {
  it('un error en prisma.sesion.findMany se loguea y revisar() no rechaza', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findMany.mockRejectedValueOnce(new Error('DB caída'));
    const errorSpy = jest.spyOn((servicio as any).logger, 'error').mockImplementation(() => {});

    await expect(servicio.revisar()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
  });

  it('tras un error, el guard corriendo se libera igual (finally) y la próxima llamada corre', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findMany.mockRejectedValueOnce(new Error('DB caída'));
    jest.spyOn((servicio as any).logger, 'error').mockImplementation(() => {});

    await servicio.revisar();

    prisma.sesion.findMany.mockResolvedValueOnce([]);
    await servicio.revisar();

    expect(prisma.sesion.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('EnergiaService.revisar — pulso de retorno (fase SALIDA)', () => {
  it('busca las sillas con sesión viva incluyendo SALIDA, para no apagar el pulso de retorno', async () => {
    const { servicio, prisma, heartbeat } = crearServicio();
    heartbeat.getSalud.mockReturnValue([
      salud({ sillaId: 'silla-1', online: true, releEncendido: true }),
    ]);
    prisma.sesion.findMany.mockResolvedValue([]);

    await servicio.revisar();

    expect(prisma.sesion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { estado: { in: expect.arrayContaining(['SALIDA']) } },
        select: { sillaId: true },
      }),
    );
  });
});
