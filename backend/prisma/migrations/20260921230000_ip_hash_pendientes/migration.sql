-- Hallazgo ALTO 2: tope de reservas pendientes por IP.
-- Se guarda un hash HMAC-SHA256 de la IP real (nunca la IP en claro) para
-- poder contar cuántas sesiones/turnos pendientes tiene una misma IP.

-- AlterTable
ALTER TABLE "sesiones" ADD COLUMN "ip_hash" TEXT;
ALTER TABLE "turnos" ADD COLUMN "ip_hash" TEXT;

-- CreateIndex
CREATE INDEX "sesiones_ip_hash_estado_idx" ON "sesiones"("ip_hash", "estado");
CREATE INDEX "turnos_ip_hash_estado_idx" ON "turnos"("ip_hash", "estado");
