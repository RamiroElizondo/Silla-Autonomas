import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pago, Prisma } from '@prisma/client';
import { ColaService } from '../cola/cola.service';
import { IpHashService } from '../common/ip-hash.service';
import { contarReservasPendientesPorIp } from '../common/reservas-pendientes.util';
import { MAX_PENDIENTES_POR_IP } from '../common/throttle.config';
import { TurnstileService } from '../common/turnstile.service';
import { CreditosService } from '../creditos/creditos.service';
import {
  MercadoPagoService,
  type PagoMP,
} from '../mercadopago/mercadopago.service';
import { PrismaService } from '../prisma/prisma.service';
import { SesionesService } from '../sesiones/sesiones.service';
import { SillasService } from '../sillas/sillas.service';
import { AccionResolucion, ResolverPagoDto } from './dto/resolver-pago.dto';

/** Texto guardado en `Pago.resolucion` según la acción elegida en el panel. */
const RESOLUCION_POR_ACCION: Record<AccionResolucion, string> = {
  emitir_vale: 'VALE_EMITIDO',
  marcar_reembolsado: 'REEMBOLSADO_MANUAL',
  ignorar: 'IGNORADO',
};

/**
 * Estados en los que Mercado Pago puede dejar un pago que ya habíamos
 * marcado APROBADO (Bloque B, hallazgo MEDIO). No se cancela la sesión ni se
 * corta la corriente automáticamente cuando esto pasa — el cliente ya usó
 * (o está usando) el servicio — así que queda para que el dueño lo resuelva
 * a mano desde /admin/pagos/revision.
 */
const ESTADOS_DE_REEMBOLSO = ['refunded', 'charged_back', 'cancelled'];

@Injectable()
export class PagosService {
  private readonly logger = new Logger(PagosService.name);
  // Fallback cuando el checkout se dispara sin `origin` (ej. pruebas manuales
  // por curl/Postman). En el uso normal lo reemplaza window.location.origin.
  private readonly frontendUrlFallback: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mp: MercadoPagoService,
    private readonly sesiones: SesionesService,
    private readonly sillas: SillasService,
    private readonly cola: ColaService,
    private readonly turnstile: TurnstileService,
    private readonly ipHash: IpHashService,
    private readonly creditos: CreditosService,
    config: ConfigService,
  ) {
    this.frontendUrlFallback = config.get<string>('FRONTEND_URL', '');
  }

  /**
   * Flujo de checkout:
   * 1. Verifica Turnstile (falla cerrada) — sin esto, no se reserva nada.
   * 2. Chequea el tope de reservas pendientes de esta IP (Hallazgo ALTO 2).
   * 3. Reserva la silla (LIBRE → PAGO_PENDIENTE, con timeout de 3 min).
   * 4. Crea la sesión con external_reference único.
   * 5. Crea la Preferencia en MP y devuelve la URL de Checkout Pro.
   *
   * `origin` (opcional) es el origin público desde el que el cliente abrió
   * la landing y se usa para los back_urls. El Webhook se configura en el
   * panel de Mercado Pago para no sobreescribir la configuración firmada.
   */
  async iniciarCheckout(
    sillaId: string,
    origin: string | undefined,
    turnstileToken: string | undefined,
    ipCliente: string,
  ) {
    const silla = await this.sillas.obtener(sillaId);

    const verificacion = await this.turnstile.verificar(turnstileToken, ipCliente);
    if (!verificacion.ok) {
      throw new ForbiddenException(
        'No pudimos verificar que sos una persona real. Volvé a intentar.',
      );
    }

    const ipHash = this.ipHash.hash(ipCliente);
    const pendientes = await contarReservasPendientesPorIp(this.prisma, ipHash);
    if (pendientes >= MAX_PENDIENTES_POR_IP) {
      throw new HttpException(
        'Ya tenés varias reservas esperando pago. Esperá a que se confirmen ' +
          'o venzan antes de intentar de nuevo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const externalReference = `${randomUUID()}|${sillaId}`;
    const sesion = await this.sesiones.crearSesionPendiente(silla, externalReference, ipHash);

    const frontendOrigin = (origin ?? this.frontendUrlFallback).replace(/\/+$/, '');

    try {
      const pref = await this.mp.crearPreferencia({
        titulo: `${silla.nombre} — ${silla.duracionMin} min de masaje`,
        precio: Number(silla.precio),
        externalReference,
        itemId: sillaId,
        // El id de sesión viaja en la URL de vuelta: sessionStorage es por
        // pestaña y Mercado Pago puede devolver al cliente en otra (o en el
        // navegador interno de una app), donde el id guardado no existe.
        successUrl: `${frontendOrigin}/silla/${sillaId}/exito?sesion=${sesion.id}`,
        failureUrl: `${frontendOrigin}/silla/${sillaId}/fracaso?sesion=${sesion.id}`,
        pendingUrl: `${frontendOrigin}/silla/${sillaId}/fracaso?sesion=${sesion.id}`,
      });
      return { sesionId: sesion.id, initPoint: pref.initPoint };
    } catch (e) {
      // Si MP falla, liberar la silla de inmediato
      await this.sesiones.expirarPagoPendiente(sesion.id);
      throw e;
    }
  }

  /**
   * El cliente cancela/abandona el checkout de MP (vuelve a `/fracaso`, o
   * pega "atrás" desde adentro de Checkout Pro). Libera la silla al toque
   * en vez de esperar el timeout de 3 min — así el siguiente cliente (o el
   * mismo, si se arrepintió del arrepentimiento) puede pagar enseguida.
   *
   * Reutiliza `expirarPagoPendiente`, que ya es idempotente y solo actúa si
   * la sesión sigue en PENDIENTE: si el pago se aprobó justo antes de que
   * esto llegue, no hace nada (gana el pago real). Se valida que la sesión
   * pertenezca a esta silla para que no se pueda cancelar la sesión de otra
   * silla adivinando un UUID.
   */
  async cancelarCheckout(sillaId: string, sesionId: string) {
    const sesion = await this.prisma.sesion.findUnique({ where: { id: sesionId } });
    if (!sesion || sesion.sillaId !== sillaId) {
      return { ok: false };
    }
    await this.sesiones.expirarPagoPendiente(sesionId);
    return { ok: true };
  }

  /**
   * Respaldo del back_url cuando el Webhook todavía no llegó. El paymentId
   * del navegador se usa únicamente para consultar la API de Mercado Pago;
   * también se comprueba que external_reference pertenezca a esta silla.
   */
  async confirmarRetornoSilla(sillaId: string, paymentId: string) {
    const pago = await this.mp.obtenerPago(paymentId);
    if (!pago?.external_reference) {
      throw new NotFoundException('Pago no encontrado en Mercado Pago');
    }
    if (pago.status !== 'approved') {
      throw new ConflictException(`El pago todavía está en estado ${pago.status}`);
    }

    const sesion = await this.prisma.sesion.findUnique({
      where: { externalReference: pago.external_reference },
      select: { id: true, sillaId: true },
    });
    if (!sesion || sesion.sillaId !== sillaId) {
      throw new NotFoundException('El pago no corresponde a esta silla');
    }

    await this.procesarPagoVerificado(paymentId, pago, {
      origen: 'checkout_return',
    });

    const estado = await this.prisma.sesion.findUnique({
      where: { id: sesion.id },
      select: { estado: true },
    });
    if (estado?.estado !== 'ACTIVA') {
      throw new ConflictException(
        'El pago fue aprobado, pero la reserva ya venció. Avisá al encargado.',
      );
    }
    return { ok: true };
  }

  /** Mismo respaldo para el pago de ingreso a la cola compartida. */
  async confirmarRetornoTurno(turnoId: string, paymentId: string) {
    const pago = await this.mp.obtenerPago(paymentId);
    if (!pago?.external_reference) {
      throw new NotFoundException('Pago no encontrado en Mercado Pago');
    }
    if (pago.status !== 'approved') {
      throw new ConflictException(`El pago todavía está en estado ${pago.status}`);
    }

    const turno = await this.prisma.turno.findUnique({
      where: { externalReference: pago.external_reference },
      select: { id: true },
    });
    if (!turno || turno.id !== turnoId) {
      throw new NotFoundException('El pago no corresponde a este turno');
    }

    await this.procesarPagoVerificado(paymentId, pago, {
      origen: 'checkout_return',
    });

    const estado = await this.prisma.turno.findUnique({
      where: { id: turno.id },
      select: { estado: true },
    });
    if (!estado || ['ESPERANDO_PAGO', 'CANCELADA'].includes(estado.estado)) {
      throw new ConflictException(
        'El pago fue aprobado, pero el turno ya venció. Avisá al encargado.',
      );
    }
    return { ok: true };
  }

  /**
   * Procesa una notificación de pago (ya validada la firma).
   * Reglas críticas: idempotencia por payment_id, verificación contra
   * la API de MP, y control de monto.
   *
   * El external_reference puede ser de dos flujos distintos: pago directo a
   * una silla puntual (Sesion) o pago para entrar a la cola compartida
   * (Turno) — se prueba primero Sesion y, si no matchea, Turno.
   *
   * No hay early-return por idempotencia acá (Bloque B): la decisión de
   * ignorar un duplicado o de detectar que un pago ya APROBADO pasó a
   * refunded/charged_back/cancelled se toma en `procesarPagoVerificado` con
   * el estado fresco que devuelve la API de MP, que es la fuente de verdad.
   */
  async procesarNotificacionPago(paymentId: string, rawBody: unknown) {
    const pago = await this.mp.obtenerPago(paymentId);
    if (!pago) {
      this.logger.warn(`Pago ${paymentId} no encontrado en MP`);
      return;
    }

    await this.procesarPagoVerificado(paymentId, pago, rawBody);
  }

  private async procesarPagoVerificado(
    paymentId: string,
    pago: PagoMP,
    rawBody: unknown,
  ) {
    // El Webhook y el retorno del navegador pueden llegar al mismo tiempo.
    const existente = await this.prisma.pago.findUnique({
      where: { paymentIdMp: paymentId },
    });
    if (existente?.estado === 'APROBADO') {
      if (ESTADOS_DE_REEMBOLSO.includes(pago.status)) {
        await this.procesarReembolsoDeAprobado(paymentId, pago, existente);
        return;
      }
      this.logger.log(`Pago ${paymentId} ya procesado, ignorado`);
      return;
    }

    if (!pago.external_reference) {
      this.logger.warn(`Pago ${paymentId} sin external_reference, ignorado`);
      return;
    }

    const sesion = await this.prisma.sesion.findUnique({
      where: { externalReference: pago.external_reference },
    });
    if (sesion) {
      await this.procesarPagoDeSesion(paymentId, pago, rawBody, sesion);
      return;
    }

    const turno = await this.prisma.turno.findUnique({
      where: { externalReference: pago.external_reference },
    });
    if (turno) {
      await this.procesarPagoDeTurno(paymentId, pago, rawBody, turno);
      return;
    }

    // external_reference desconocido (Bloque B, hallazgo MEDIO): si el pago
    // está aprobado, la plata es real aunque no sepamos qué activar — hay
    // que dejar registro para que el dueño lo revise, en vez de perderlo de
    // vista con solo un warning en el log. Un pago no aprobado con
    // referencia desconocida no tiene plata en juego, así que solo se loguea.
    if (pago.status === 'approved') {
      await this.registrarEstadoPago(paymentId, true, {
        monto: pago.transaction_amount,
        rawWebhook: PagosService.clonarRawBody(rawBody),
        requiereRevision: true,
        motivoRevision: 'external_reference_desconocido',
      });
    }
    this.logger.warn(
      `Pago ${paymentId} con external_reference desconocido: ${pago.external_reference}`,
    );
  }

  /**
   * Un pago que ya habíamos registrado como APROBADO pasó a
   * refunded/charged_back/cancelled (Bloque B, hallazgo MEDIO). No se corta
   * la corriente ni se cancela la sesión automáticamente: el cliente ya usó
   * (o está usando) el servicio, así que el dueño lo resuelve a mano desde
   * /admin/pagos/revision.
   *
   * `updateMany` con `estado: 'APROBADO'` en el where hace la transición
   * atómica frente a notificaciones duplicadas concurrentes: solo el primer
   * proceso que llega ve `count > 0` y sigue de largo con el log/aviso.
   */
  private async procesarReembolsoDeAprobado(
    paymentId: string,
    pago: PagoMP,
    existente: Pago,
  ): Promise<void> {
    const actualizado = await this.prisma.pago.updateMany({
      where: { paymentIdMp: paymentId, estado: 'APROBADO' },
      data: {
        estado: 'REEMBOLSADO',
        requiereRevision: true,
        motivoRevision: `pago_${pago.status}`,
      },
    });
    if (actualizado.count === 0) {
      // Otra notificación concurrente ya hizo esta misma transición.
      this.logger.log(
        `Pago ${paymentId}: transición a reembolso ya aplicada, ignorado`,
      );
      return;
    }

    this.logger.error(
      `Pago ${paymentId} pasó de APROBADO a ${pago.status} (revisar manualmente en el panel)`,
    );

    if (existente.sesionId) {
      const sesion = await this.prisma.sesion.findUnique({
        where: { id: existente.sesionId },
        select: { estado: true },
      });
      if (sesion?.estado === 'ACTIVA') {
        this.logger.warn(
          `Pago ${paymentId}: la sesión ${existente.sesionId} sigue ACTIVA pese al ` +
            `${pago.status} — no se corta la corriente automáticamente, requiere revisión manual`,
        );
      }
    }
  }

  private async procesarPagoDeSesion(
    paymentId: string,
    pago: PagoMP,
    rawBody: unknown,
    sesion: { id: string; monto: unknown },
  ) {
    const aprobado = pago.status === 'approved';
    const montoOk = pago.transaction_amount >= Number(sesion.monto);
    const monedaOk = !pago.currency_id || pago.currency_id === 'ARS';

    // Bloque B (hallazgo MEDIO): un pago aprobado en otra moneda o con monto
    // insuficiente no debe activar la silla, pero tampoco puede quedar solo
    // en un log — se marca para que el dueño lo revise a mano.
    let motivoRevision: string | undefined;
    if (aprobado && !monedaOk) motivoRevision = 'moneda_no_ars';
    else if (aprobado && !montoOk) motivoRevision = 'monto_insuficiente';

    const debeAplicar = await this.registrarEstadoPago(paymentId, aprobado, {
      sesionId: sesion.id,
      monto: pago.transaction_amount,
      rawWebhook: PagosService.clonarRawBody(rawBody),
      requiereRevision: motivoRevision !== undefined,
      motivoRevision,
    });

    if (!aprobado) {
      this.logger.log(`Pago ${paymentId} en estado ${pago.status}, no activa silla`);
      return;
    }
    if (!debeAplicar) return;
    if (motivoRevision) {
      this.logger.error(
        `Pago ${paymentId} aprobado pero requiere revisión (${motivoRevision}): no activa la silla`,
      );
      return;
    }

    try {
      await this.sesiones.esperarConfirmacion(sesion.id);
      this.logger.log(
        `Pago ${paymentId} aprobado → sesión ${sesion.id} reservada, esperando que el cliente confirme`,
      );
    } catch (e) {
      if (e instanceof ConflictException) {
        // La sesión ya no estaba PENDIENTE (se canceló por timeout, por el
        // endpoint de cancelación, o la silla ya se liberó). El pago quedó
        // igual registrado como APROBADO en la tabla `pagos` para auditoría
        // y marcado para revisión manual (probable reembolso) porque el
        // cliente pagó pero no se le encendió la silla.
        await this.marcarParaRevision(paymentId, 'sesion_no_pendiente');
        this.logger.error(
          `Pago ${paymentId} aprobado pero la sesión ${sesion.id} ya no estaba pendiente ` +
            `(revisar manualmente — posible reembolso): ${e.message}`,
        );
        return;
      }
      throw e;
    }
  }

  private async procesarPagoDeTurno(
    paymentId: string,
    pago: PagoMP,
    rawBody: unknown,
    turno: { id: string; monto: unknown },
  ) {
    const aprobado = pago.status === 'approved';
    const montoOk = pago.transaction_amount >= Number(turno.monto);
    const monedaOk = !pago.currency_id || pago.currency_id === 'ARS';

    let motivoRevision: string | undefined;
    if (aprobado && !monedaOk) motivoRevision = 'moneda_no_ars';
    else if (aprobado && !montoOk) motivoRevision = 'monto_insuficiente';

    const debeAplicar = await this.registrarEstadoPago(paymentId, aprobado, {
      turnoId: turno.id,
      monto: pago.transaction_amount,
      rawWebhook: PagosService.clonarRawBody(rawBody),
      requiereRevision: motivoRevision !== undefined,
      motivoRevision,
    });

    if (!aprobado) {
      this.logger.log(`Pago ${paymentId} en estado ${pago.status}, no anota en cola`);
      return;
    }
    if (!debeAplicar) return;
    if (motivoRevision) {
      this.logger.error(
        `Pago ${paymentId} aprobado pero requiere revisión (${motivoRevision}): no anota en cola`,
      );
      return;
    }

    try {
      await this.cola.procesarPagoAprobado(turno.id);
      this.logger.log(`Pago ${paymentId} aprobado → turno ${turno.id} en cola`);
    } catch (e) {
      if (e instanceof ConflictException) {
        // Mismo caso que en procesarPagoDeSesion: el turno ya no estaba en
        // condiciones de aplicar el pago (venció, se canceló). Auditoría +
        // revisión manual en vez de perder el registro de la plata.
        await this.marcarParaRevision(paymentId, 'turno_no_pendiente');
        this.logger.error(
          `Pago ${paymentId} aprobado pero el turno ${turno.id} ya no estaba pendiente ` +
            `(revisar manualmente — posible reembolso): ${e.message}`,
        );
        return;
      }
      throw e;
    }
  }

  /**
   * Marca un pago ya registrado (creado en `registrarEstadoPago`) para
   * revisión manual porque, al intentar aplicarlo, la sesión/turno ya no
   * estaba en condiciones de recibirlo.
   */
  private async marcarParaRevision(paymentId: string, motivo: string): Promise<void> {
    await this.prisma.pago.update({
      where: { paymentIdMp: paymentId },
      data: { requiereRevision: true, motivoRevision: motivo },
    });
  }

  private static clonarRawBody(rawBody: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(rawBody ?? {}));
  }

  /**
   * Registra una notificación de forma atómica frente a la carrera entre el
   * Webhook y el back_url. Devuelve true solo al proceso que debe aplicar el
   * pago aprobado a la silla/cola.
   */
  private async registrarEstadoPago(
    paymentId: string,
    aprobado: boolean,
    data: Omit<Prisma.PagoUncheckedCreateInput, 'paymentIdMp' | 'estado'>,
  ): Promise<boolean> {
    if (aprobado) {
      const actualizado = await this.prisma.pago.updateMany({
        where: { paymentIdMp: paymentId, estado: 'RECHAZADO' },
        data: {
          estado: 'APROBADO',
          monto: data.monto,
          rawWebhook: data.rawWebhook,
          requiereRevision: data.requiereRevision,
          motivoRevision: data.motivoRevision,
        },
      });
      if (actualizado.count > 0) return true;
    }

    try {
      await this.prisma.pago.create({
        data: {
          ...data,
          paymentIdMp: paymentId,
          estado: aprobado ? 'APROBADO' : 'RECHAZADO',
        },
      });
      return aprobado;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Pagos marcados para revisión manual (Bloque B) que el dueño todavía no
   * resolvió, más recientes primero. Incluye la silla/turno de origen para
   * que el panel pueda mostrar contexto sin otro pedido.
   */
  async listarPagosParaRevision(take = 50) {
    const pagos = await this.prisma.pago.findMany({
      where: { requiereRevision: true, resueltoEn: null },
      take,
      orderBy: { recibidoEn: 'desc' },
      include: {
        sesion: { select: { id: true, sillaId: true, silla: { select: { nombre: true } } } },
        turno: { select: { id: true, sillaId: true, codigo: true } },
      },
    });
    // Decimal → number para el frontend (mismo criterio que AdminService.sillas()).
    return pagos.map((p) => ({ ...p, monto: Number(p.monto) }));
  }

  /**
   * Resuelve a mano un pago marcado para revisión (Bloque B). Idempotente:
   * un segundo pedido sobre el mismo pago ya resuelto no vuelve a emitir el
   * vale ni a tocar nada — devuelve el pago tal como quedó la primera vez.
   *
   * 'emitir_vale' usa la duración de la sesión/turno original; si el pago
   * no tiene ninguno asociado (external_reference desconocido) exige
   * `duracionMinVale` en el DTO. Nota: `Credito` no tiene un campo de origen
   * para Turno (solo para Sesion), así que un vale emitido a partir de un
   * pago de turno no queda enlazado a `sesionOrigenId` — limitación
   * conocida, documentada en el informe.
   */
  async resolverPagoParaRevision(pagoId: string, dto: ResolverPagoDto) {
    const pago = await this.prisma.pago.findUnique({
      where: { id: pagoId },
      include: { sesion: true, turno: true },
    });
    if (!pago) throw new NotFoundException('Pago no encontrado');
    if (!pago.requiereRevision) {
      throw new ConflictException('Este pago no está marcado para revisión');
    }
    if (pago.resueltoEn) {
      return pago; // ya resuelto antes (doble click / reintento): no repetir la acción
    }

    let duracionMin: number | undefined;
    let sesionOrigenId: string | undefined;
    if (pago.sesion) {
      duracionMin = pago.sesion.duracionMin;
      sesionOrigenId = pago.sesion.id;
    } else if (pago.turno) {
      duracionMin = pago.turno.duracionMin;
    } else {
      duracionMin = dto.duracionMinVale;
    }

    if (dto.accion === 'emitir_vale' && !duracionMin) {
      throw new BadRequestException(
        'Este pago no tiene sesión ni turno asociado: indicá duracionMinVale',
      );
    }

    const actualizado = await this.prisma.pago.updateMany({
      where: { id: pagoId, resueltoEn: null },
      data: {
        resolucion: RESOLUCION_POR_ACCION[dto.accion],
        resueltoEn: new Date(),
        // Recién acá, cuando el dueño confirma que reembolsó al cliente por
        // fuera del sistema, se excluye el pago de los ingresos. En
        // 'emitir_vale' e 'ignorar' la plata sigue siendo real: el pago
        // queda APROBADO igual, solo se resuelve cómo se atendió al cliente.
        estado: dto.accion === 'marcar_reembolsado' ? 'REEMBOLSADO' : pago.estado,
      },
    });
    if (actualizado.count === 0) {
      // Otro pedido concurrente ya lo resolvió (doble click): no emitir el
      // vale dos veces, devolver el estado actual tal cual quedó.
      return this.prisma.pago.findUniqueOrThrow({ where: { id: pagoId } });
    }

    if (dto.accion === 'emitir_vale') {
      await this.creditos.emitir({
        duracionMin: duracionMin!,
        motivo: `revision_pago:${pago.motivoRevision ?? 'sin_motivo'}`,
        sesionOrigenId,
        prioridadDesde: pago.recibidoEn,
      });
    }

    return this.prisma.pago.findUniqueOrThrow({ where: { id: pagoId } });
  }
}
