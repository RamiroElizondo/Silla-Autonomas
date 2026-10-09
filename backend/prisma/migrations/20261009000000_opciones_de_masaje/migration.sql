-- Dos opciones de masaje por sillón. El precio/duración que ya existía pasa a
-- ser la opción 2 (la que viene seleccionada); la opción 1 arranca en 5 min a
-- mitad de precio, para que el dueño la ajuste desde el panel.
ALTER TABLE "sillas" RENAME COLUMN "precio" TO "opcion2_precio";
ALTER TABLE "sillas" RENAME COLUMN "duracion_min" TO "opcion2_duracion_min";

ALTER TABLE "sillas"
  ADD COLUMN "opcion1_duracion_min" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "opcion1_precio" DECIMAL(10,2);

UPDATE "sillas" SET "opcion1_precio" = GREATEST(1, ROUND("opcion2_precio" / 2));

ALTER TABLE "sillas" ALTER COLUMN "opcion1_precio" SET NOT NULL;

-- Qué opción eligió el cliente (null: manual, canje de vale o anterior a esto).
ALTER TABLE "sesiones" ADD COLUMN "opcion" INTEGER;
ALTER TABLE "turnos" ADD COLUMN "opcion" INTEGER;
