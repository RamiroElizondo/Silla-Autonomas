-- CreateEnum
CREATE TYPE "EstadoTurno" AS ENUM ('ESPERANDO_PAGO', 'EN_COLA', 'ASIGNADO', 'EN_USO', 'COMPLETADA', 'CANCELADA');

-- AlterEnum
ALTER TYPE "EstadoSilla" ADD VALUE 'RESERVADA';

-- DropForeignKey
ALTER TABLE "pagos" DROP CONSTRAINT "pagos_sesion_id_fkey";

-- AlterTable
ALTER TABLE "pagos" ADD COLUMN     "turno_id" TEXT,
ALTER COLUMN "sesion_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "turnos" (
    "id" TEXT NOT NULL,
    "codigo" TEXT,
    "estado" "EstadoTurno" NOT NULL DEFAULT 'ESPERANDO_PAGO',
    "external_reference" TEXT NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "duracion_min" INTEGER NOT NULL,
    "silla_id" TEXT,
    "sesion_id" TEXT,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pagado_en" TIMESTAMP(3),
    "asignado_en" TIMESTAMP(3),
    "fin_real" TIMESTAMP(3),
    "motivo_cierre" TEXT,

    CONSTRAINT "turnos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "turnos_codigo_key" ON "turnos"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "turnos_external_reference_key" ON "turnos"("external_reference");

-- CreateIndex
CREATE UNIQUE INDEX "turnos_sesion_id_key" ON "turnos"("sesion_id");

-- CreateIndex
CREATE INDEX "turnos_estado_pagado_en_idx" ON "turnos"("estado", "pagado_en");

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_sesion_id_fkey" FOREIGN KEY ("sesion_id") REFERENCES "sesiones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_turno_id_fkey" FOREIGN KEY ("turno_id") REFERENCES "turnos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turnos" ADD CONSTRAINT "turnos_silla_id_fkey" FOREIGN KEY ("silla_id") REFERENCES "sillas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turnos" ADD CONSTRAINT "turnos_sesion_id_fkey" FOREIGN KEY ("sesion_id") REFERENCES "sesiones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
