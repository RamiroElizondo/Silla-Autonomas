-- Bloque B (hallazgo MEDIO): pagos aprobados que no activaron ningún
-- servicio, y pagos que Mercado Pago marcó refunded/charged_back/cancelled
-- después de haber sido APROBADO. Se resuelven a mano desde
-- /admin/pagos/revision.

-- No se puede usar el nuevo valor del enum en la misma transacción en la que
-- se crea (limitación de Postgres); esta migración no lo necesita, así que
-- no hay problema en que ambos pasos vayan en un solo archivo.
ALTER TYPE "EstadoPago" ADD VALUE 'REEMBOLSADO';

ALTER TABLE "pagos" ADD COLUMN "requiere_revision" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pagos" ADD COLUMN "motivo_revision" TEXT;
ALTER TABLE "pagos" ADD COLUMN "resolucion" TEXT;
ALTER TABLE "pagos" ADD COLUMN "resuelto_en" TIMESTAMP(3);

CREATE INDEX "pagos_requiere_revision_resuelto_en_idx" ON "pagos"("requiere_revision", "resuelto_en");
