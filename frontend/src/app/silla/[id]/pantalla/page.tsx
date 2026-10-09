import { redirect } from "next/navigation";

/**
 * La pantalla TV pasó a ser una sola para todo el local (`/pantalla`). Esta
 * ruta queda solo para que una TV configurada con la URL vieja siga andando.
 */
export default function PantallaPorSillon() {
  redirect("/pantalla");
}
