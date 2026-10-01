-- Tiempos propios de la masajeadora: gracia de inicio (sentarse y presionar
-- START), pausa al terminar y pulso de retorno para que la silla se levante.
ALTER TYPE "EstadoSesion" ADD VALUE 'SALIDA';

ALTER TABLE "sillas"
  ADD COLUMN "gracia_inicio_seg" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "pausa_retorno_seg" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "retorno_seg" INTEGER NOT NULL DEFAULT 40;

ALTER TABLE "sesiones"
  ADD COLUMN "gracia_inicio_seg" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "pausa_retorno_seg" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "retorno_seg" INTEGER NOT NULL DEFAULT 40,
  ADD COLUMN "salida_hasta" TIMESTAMP(3);
