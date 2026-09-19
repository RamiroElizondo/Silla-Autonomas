-- AlterEnum: sesión pagada que todavía no pudo encender la silla (Shelly sin luz/WiFi)
ALTER TYPE "EstadoSesion" ADD VALUE 'ESPERANDO_ENERGIA';

-- CreateEnum
CREATE TYPE "EstadoCredito" AS ENUM ('DISPONIBLE', 'CANJEADO', 'VENCIDO');

-- AlterTable
ALTER TABLE "sesiones"
  ADD COLUMN "pagada_en" TIMESTAMP(3),
  ADD COLUMN "interrumpida_en" TIMESTAMP(3),
  ADD COLUMN "segundos_compensados" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cortes" INTEGER NOT NULL DEFAULT 0;

-- Backfill: las sesiones ya cobradas conservan su hora de arranque como hora de pago.
UPDATE "sesiones" SET "pagada_en" = "inicio" WHERE "inicio" IS NOT NULL AND "es_manual" = false;

-- CreateTable
CREATE TABLE "creditos" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "estado" "EstadoCredito" NOT NULL DEFAULT 'DISPONIBLE',
    "duracion_min" INTEGER NOT NULL,
    "motivo" TEXT NOT NULL,
    "prioridad_desde" TIMESTAMP(3) NOT NULL,
    "sesion_origen_id" TEXT,
    "turno_generado_id" TEXT,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vence_en" TIMESTAMP(3) NOT NULL,
    "canjeado_en" TIMESTAMP(3),

    CONSTRAINT "creditos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "creditos_codigo_key" ON "creditos"("codigo");
CREATE UNIQUE INDEX "creditos_turno_generado_id_key" ON "creditos"("turno_generado_id");
CREATE INDEX "creditos_estado_vence_en_idx" ON "creditos"("estado", "vence_en");

-- AddForeignKey
ALTER TABLE "creditos" ADD CONSTRAINT "creditos_sesion_origen_id_fkey" FOREIGN KEY ("sesion_origen_id") REFERENCES "sesiones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "creditos" ADD CONSTRAINT "creditos_turno_generado_id_fkey" FOREIGN KEY ("turno_generado_id") REFERENCES "turnos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
