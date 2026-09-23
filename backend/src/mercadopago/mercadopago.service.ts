import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

export interface PagoMP {
  id: number;
  status: string; // approved | rejected | pending | ...
  transaction_amount: number;
  // Bloque B (hallazgo MEDIO): un pago aprobado en otra moneda no debe
  // activar la silla. Puede faltar en respuestas viejas/mockeadas, por eso
  // el chequeo en PagosService la trata como ARS si no vino.
  currency_id?: string;
  external_reference: string | null;
  [k: string]: unknown;
}

/** Firma ya separada y validada en forma (no en contenido: eso lo hace HMAC). */
interface XSignatureParseada {
  ts: string;
  v1: string;
}

/**
 * Parsea el header `x-signature` de Mercado Pago de forma estricta: rechaza
 * (devolviendo `null`, sin tirar excepción) cualquier cosa que no sea
 * exactamente lo que MP manda — un campo sin "=", un campo vacío, una clave
 * repetida, o un "v1" que no sea hex de 64 caracteres (lo que produce
 * cualquier HMAC-SHA256 en hex). No se valida ventana de tiempo sobre "ts":
 * MP reintenta webhooks fallidos durante horas, así que un ts viejo es
 * normal y no dice nada sobre si la firma es válida.
 */
function parsearXSignature(header: string): XSignatureParseada | null {
  const partes: Record<string, string> = {};
  for (const segmento of header.split(',')) {
    const idx = segmento.indexOf('=');
    if (idx === -1) return null; // sin "=": formato inesperado
    const clave = segmento.slice(0, idx).trim();
    const valor = segmento.slice(idx + 1).trim();
    if (!clave || !valor) return null; // campo vacío
    if (clave in partes) return null; // clave duplicada
    partes[clave] = valor;
  }
  if (!partes.ts || !partes.v1) return null;
  if (!/^[0-9a-f]{64}$/i.test(partes.v1)) return null; // HMAC-SHA256 en hex: siempre 64 chars
  return { ts: partes.ts, v1: partes.v1 };
}

/** Resultado de parsear el esquema de `paymentId` simulado de LOADTEST. */
interface PagoLoadtestParseado {
  externalReference: string;
  monto: number;
}

/**
 * Cliente de la API de Mercado Pago (Checkout Pro + Payments), vía SDK
 * oficial. Vive en su propio módulo porque lo usan tanto el pago directo a
 * una silla (PagosModule) como el pago para entrar a la cola (ColaModule).
 */
@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);
  private readonly webhookSecret: string;
  /**
   * Escape hatch SOLO para desarrollo local sin secreto configurado (Hallazgo
   * ALTO 4): antes, sin `MP_WEBHOOK_SECRET` el webhook fallaba "abierto"
   * (aceptaba cualquier request sin firma) en cualquier entorno, incluida
   * producción por error de configuración. Ahora falla CERRADO por defecto;
   * esta bandera es la única forma de recuperar el comportamiento viejo, y
   * `verificarEntornoDeArranque` aborta el arranque si se llega a producción
   * sin secreto (con o sin esta bandera).
   */
  private readonly permitirSinFirma: boolean;
  private readonly preference: Preference;
  private readonly payment: Payment;

  /**
   * Bloque de loadtest (`backend/loadtest/`): con `LOADTEST=true`, este
   * servicio queda completamente mockeado — `crearPreferencia` y
   * `obtenerPago` nunca llaman al SDK real de Mercado Pago. Es necesario
   * para poder tirar carga sin aprobar pagos de sandbox reales miles de
   * veces (y, por error de configuración, sin arriesgarse a pegarle a
   * producción con plata real). `verificarEntornoDeArranque` aborta el
   * arranque si esto llegara a estar activo con `NODE_ENV=production` — acá
   * no hay ninguna excepción posible, a diferencia de `permitirSinFirma`.
   */
  private readonly loadtest: boolean;

  /** Prefijo que identifica un `paymentId` simulado de LOADTEST. */
  private static readonly PREFIJO_LOADTEST = 'loadtest:';

  constructor(config: ConfigService) {
    const accessToken = config.get<string>('MP_ACCESS_TOKEN', '');
    this.webhookSecret = config.get<string>('MP_WEBHOOK_SECRET', '');
    this.permitirSinFirma =
      !this.webhookSecret &&
      config.get<string>('MP_WEBHOOK_ALLOW_UNSIGNED', '') === 'true';
    this.loadtest = config.get<string>('LOADTEST', '') === 'true';

    if (!this.webhookSecret) {
      if (this.permitirSinFirma) {
        this.logger.warn(
          'MP_WEBHOOK_ALLOW_UNSIGNED=true: el webhook de Mercado Pago acepta ' +
            'notificaciones SIN validar firma. Es un agujero de seguridad — ' +
            'NUNCA usar esta bandera fuera de desarrollo local.',
        );
      } else {
        this.logger.warn(
          'MP_WEBHOOK_SECRET no configurado: el webhook de Mercado Pago va a ' +
            'RECHAZAR todas las notificaciones (falla cerrado). Configurá el ' +
            'secreto, o (solo en desarrollo) MP_WEBHOOK_ALLOW_UNSIGNED=true.',
        );
      }
    }

    if (this.loadtest) {
      this.logger.warn(
        'LOADTEST=true: MercadoPagoService está MOCKEADO — crearPreferencia y ' +
          'obtenerPago no llaman al SDK real de Mercado Pago. NUNCA debe estar ' +
          'activo en producción (ver verificarEntornoDeArranque).',
      );
    }

    const client = new MercadoPagoConfig({ accessToken });
    this.preference = new Preference(client);
    this.payment = new Payment(client);
  }

  /** Crea la Preferencia de Checkout Pro. Devuelve la URL de pago (init_point). */
  async crearPreferencia(params: {
    titulo: string;
    precio: number;
    externalReference: string;
    itemId: string;
    successUrl: string;
    failureUrl: string;
    pendingUrl: string;
    /** Minutos de vigencia de la preferencia (por defecto 3). */
    vigenciaMin?: number;
  }): Promise<{ id: string; initPoint: string }> {
    if (this.loadtest) {
      return this.crearPreferenciaSimulada(params.externalReference);
    }

    try {
      const result = await this.preference.create({
        body: {
          items: [
            {
              id: params.itemId,
              title: params.titulo,
              quantity: 1,
              unit_price: params.precio,
              currency_id: 'ARS',
            },
          ],
          external_reference: params.externalReference,
          // La URL del Webhook se administra en Tus integraciones. No se
          // sobreescribe por preferencia: la firma secreta corresponde a la
          // configuración registrada de la aplicación.
          back_urls: {
            success: params.successUrl,
            failure: params.failureUrl,
            pending: params.pendingUrl,
          },
          auto_return: 'approved',
          // No aceptar pagos tardíos de una reserva/turno ya expirado
          expires: true,
          expiration_date_to: new Date(
            Date.now() + (params.vigenciaMin ?? 3) * 60_000,
          ).toISOString(),
        },
      });

      if (!result.id || !result.init_point) {
        throw new Error('Respuesta de MP sin id/init_point');
      }
      return { id: result.id, initPoint: result.init_point };
    } catch (err) {
      this.logger.error(`Error creando preferencia: ${JSON.stringify(err)}`);
      throw new Error('No se pudo crear la preferencia de pago');
    }
  }

  /**
   * Bloque de loadtest: devuelve una preferencia simulada, determinística en
   * su forma (siempre el mismo `initPoint` de juguete), sin tocar la red ni
   * el SDK de MP. El `id` es único por llamada (no hace falta que un script
   * de carga lo controle: nada del sistema depende de su valor).
   */
  private crearPreferenciaSimulada(externalReference: string): {
    id: string;
    initPoint: string;
  } {
    const id = `loadtest-pref-${randomUUID()}`;
    this.logger.log(
      `LOADTEST=true: preferencia simulada ${id} para external_reference=` +
        `${externalReference} (sin llamar al SDK real de MP)`,
    );
    return { id, initPoint: 'https://loadtest.local/fake-checkout' };
  }

  /**
   * Consulta el pago REAL contra la API de MP.
   * Regla crítica: nunca confiar solo en el body del webhook.
   *
   * Bloque de loadtest: con `LOADTEST=true`, devuelve un pago simulado ya
   * APROBADO en vez de consultar la API real — ver `obtenerPagoSimulado`.
   */
  async obtenerPago(paymentId: string): Promise<PagoMP | null> {
    if (this.loadtest) {
      return this.obtenerPagoSimulado(paymentId);
    }

    try {
      const result = await this.payment.get({ id: paymentId });
      return result as unknown as PagoMP;
    } catch (err) {
      this.logger.warn(`GET /v1/payments/${paymentId} → ${JSON.stringify(err)}`);
      return null;
    }
  }

  /**
   * Bloque de loadtest: simula un pago ya APROBADO sin llamar a la API real
   * de Mercado Pago (necesario porque el webhook/retorno de pago consultan
   * `obtenerPago` para verificar el pago real antes de activar la silla —
   * ver `PagosService.procesarNotificacionPago`).
   *
   * El script de carga necesita poder controlar el monto y el
   * `external_reference` del pago simulado (para poder apuntar a una sesión
   * real y ejercitar el chequeo de monto del Bloque B), así que ambos se
   * codifican en el propio `paymentId` recibido, con el esquema:
   *
   *   loadtest:<externalReference>:<monto>
   *
   * `backend/loadtest/03-webhook.js` arma el `paymentId` (usado como
   * `data.id`) exactamente con este formato — si se cambia este esquema acá,
   * hay que actualizar ese script también.
   *
   * Si `paymentId` no sigue el esquema (por ejemplo, un id numérico suelto
   * pasado a mano), igual se devuelve un pago aprobado, pero con
   * `external_reference: null` y `transaction_amount: 0` — sirve para medir
   * latencia/throughput del endpoint, pero no activa ninguna sesión real
   * (ver `PagosService.procesarPagoVerificado`, que ignora los pagos sin
   * `external_reference`).
   */
  private obtenerPagoSimulado(paymentId: string): PagoMP {
    const parseado = this.parsearPaymentIdLoadtest(paymentId);
    if (!parseado) {
      this.logger.warn(
        `LOADTEST=true: paymentId "${paymentId}" no sigue el esquema ` +
          '"loadtest:<externalReference>:<monto>"; se simula un pago aprobado ' +
          'sin external_reference (no va a activar ninguna sesión real).',
      );
    }
    return {
      id: this.idNumericoSimulado(paymentId),
      status: 'approved',
      transaction_amount: parseado?.monto ?? 0,
      currency_id: 'ARS',
      external_reference: parseado?.externalReference ?? null,
    };
  }

  private parsearPaymentIdLoadtest(paymentId: string): PagoLoadtestParseado | null {
    if (!paymentId.startsWith(MercadoPagoService.PREFIJO_LOADTEST)) return null;
    const resto = paymentId.slice(MercadoPagoService.PREFIJO_LOADTEST.length);
    const idxSeparador = resto.lastIndexOf(':');
    if (idxSeparador === -1) return null;

    const externalReference = resto.slice(0, idxSeparador);
    const monto = Number(resto.slice(idxSeparador + 1));
    if (!externalReference || !Number.isFinite(monto)) return null;

    return { externalReference, monto };
  }

  /**
   * `PagoMP.id` no se usa para nada crítico en el resto del sistema (la
   * clave de idempotencia real es el propio `paymentId` string, guardado en
   * `Pago.paymentIdMp`), así que alcanza con un número estable derivado del
   * `paymentId` — no hace falta que sea criptográfico ni único de verdad.
   */
  private idNumericoSimulado(paymentId: string): number {
    let hash = 0;
    for (let i = 0; i < paymentId.length; i++) {
      hash = (hash * 31 + paymentId.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  /**
   * Valida la firma HMAC del webhook (header x-signature).
   * Manifest según docs de MP: "id:{data.id};request-id:{x-request-id};ts:{ts};"
   *
   * Falla CERRADO (Hallazgo ALTO 4): sin secreto configurado, rechaza todo
   * salvo que se haya optado explícitamente por `permitirSinFirma` (ver
   * constructor). `verificarEntornoDeArranque` ya garantiza que esto nunca
   * pasa en producción sin que alguien lo haya pedido a propósito.
   */
  validarFirma(params: {
    xSignature: string | undefined;
    xRequestId: string | undefined;
    dataId: string | undefined;
  }): boolean {
    if (!this.webhookSecret) {
      return this.permitirSinFirma;
    }
    if (!params.xSignature) {
      this.logger.warn('Webhook sin header x-signature');
      return false;
    }

    const parseada = parsearXSignature(params.xSignature);
    if (!parseada) {
      this.logger.warn('Webhook con x-signature de formato inválido');
      return false;
    }

    let manifest = '';
    if (params.dataId) manifest += `id:${params.dataId.toLowerCase()};`;
    if (params.xRequestId) manifest += `request-id:${params.xRequestId};`;
    manifest += `ts:${parseada.ts};`;

    const esperado = createHmac('sha256', this.webhookSecret)
      .update(manifest)
      .digest('hex');

    let coincide: boolean;
    try {
      coincide =
        esperado.length === parseada.v1.length &&
        timingSafeEqual(Buffer.from(esperado), Buffer.from(parseada.v1));
    } catch {
      coincide = false;
    }

    if (!coincide) {
      // Nunca loguear el HMAC esperado/recibido ni la longitud del secreto:
      // eso es exactamente la información que un atacante necesitaría para
      // confirmar que va por buen camino forzando la firma a fuerza bruta.
      this.logger.warn(
        `Firma de webhook no coincide (data.id=${params.dataId ?? 'sin dato'}, ` +
          `x-request-id=${params.xRequestId ?? 'sin dato'})`,
      );
    }

    return coincide;
  }
}
