-- Hallazgo MEDIO (Bloque A): revocación de sesiones de admin.
-- tokenVersion se incrementa en cada logout; JwtAuthGuard rechaza cualquier
-- token cuyo tokenVersion no coincida con el valor actual en la base.
ALTER TABLE "usuarios_admin" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;
