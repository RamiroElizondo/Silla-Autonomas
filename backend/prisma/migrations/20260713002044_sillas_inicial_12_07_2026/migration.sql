-- CreateEnum
CREATE TYPE "EstadoSilla" AS ENUM ('LIBRE', 'PAGO_PENDIENTE', 'EN_USO', 'FUERA_DE_SERVICIO');

-- CreateEnum
CREATE TYPE "EstadoSesion" AS ENUM ('PENDIENTE', 'ACTIVA', 'COMPLETADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "EstadoPago" AS ENUM ('PENDIENTE', 'APROBADO', 'RECHAZADO');

-- CreateTable
CREATE TABLE "sillas" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "estado" "EstadoSilla" NOT NULL DEFAULT 'LIBRE',
    "precio" DECIMAL(10,2) NOT NULL,
    "duracion_min" INTEGER NOT NULL DEFAULT 10,
    "device_id_shelly" TEXT NOT NULL,
    "modelo_shelly" TEXT,
    "fin_sesion_actual" TIMESTAMP(3),
    "creada_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sillas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sesiones" (
    "id" TEXT NOT NULL,
    "silla_id" TEXT NOT NULL,
    "estado" "EstadoSesion" NOT NULL DEFAULT 'PENDIENTE',
    "external_reference" TEXT NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "duracion_min" INTEGER NOT NULL,
    "es_manual" BOOLEAN NOT NULL DEFAULT false,
    "creada_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inicio" TIMESTAMP(3),
    "fin_programado" TIMESTAMP(3),
    "fin_real" TIMESTAMP(3),
    "motivo_cierre" TEXT,

    CONSTRAINT "sesiones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pagos" (
    "id" TEXT NOT NULL,
    "sesion_id" TEXT NOT NULL,
    "payment_id_mp" TEXT NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "estado" "EstadoPago" NOT NULL,
    "raw_webhook" JSONB,
    "recibido_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pagos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuarios_admin" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "ultimo_login" TIMESTAMP(3),
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuarios_admin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sesiones_external_reference_key" ON "sesiones"("external_reference");

-- CreateIndex
CREATE INDEX "sesiones_silla_id_estado_idx" ON "sesiones"("silla_id", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "pagos_payment_id_mp_key" ON "pagos"("payment_id_mp");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_admin_email_key" ON "usuarios_admin"("email");

-- AddForeignKey
ALTER TABLE "sesiones" ADD CONSTRAINT "sesiones_silla_id_fkey" FOREIGN KEY ("silla_id") REFERENCES "sillas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_sesion_id_fkey" FOREIGN KEY ("sesion_id") REFERENCES "sesiones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
