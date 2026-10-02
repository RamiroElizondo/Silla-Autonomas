/**
 * Dibujo de los botones del control de la masajeadora, para que el cliente
 * los reconozca en el control físico:
 *
 *  - START: botón oscuro con el ícono de encendido en rojo.
 *  - OK:    botón redondo central de la cruceta, con un cuadrado doble.
 *
 * SVG en línea (sin imágenes) para que se vea nítido en el celular y en la TV.
 */
export function BotonControl({
  tipo,
  tamano = 64,
  className = "",
}: {
  tipo: "start" | "ok";
  tamano?: number;
  className?: string;
}) {
  if (tipo === "start") {
    return (
      <svg
        width={tamano}
        height={tamano * 0.75}
        viewBox="0 0 80 60"
        role="img"
        aria-label="Botón START (ícono de encendido rojo)"
        className={className}
      >
        <rect x="2" y="2" width="76" height="56" rx="12" fill="#1F1D1B" />
        <rect x="6" y="6" width="68" height="48" rx="9" fill="#2B2826" />
        {/* dos marcas chicas arriba a la izquierda, como en el control */}
        <path d="M24 16v5M29 16v5" stroke="#CFC9BF" strokeWidth="1.6" strokeLinecap="round" />
        {/* ícono de encendido */}
        <path
          d="M32.5 23.5a11 11 0 1 0 15 0"
          fill="none"
          stroke="#D9382B"
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        <path d="M40 18v13" stroke="#D9382B" strokeWidth="4.5" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg
      width={tamano}
      height={tamano}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Botón OK (cuadrado doble, en el centro de las flechas)"
      className={className}
    >
      {/* insinuación de la cruceta alrededor */}
      <circle cx="32" cy="32" r="30" fill="#1F1D1B" />
      <path d="M32 6l-4 4M32 6l4 4" stroke="#8C867D" strokeWidth="2" strokeLinecap="round" />
      <path d="M32 58l-4-4M32 58l4-4" stroke="#8C867D" strokeWidth="2" strokeLinecap="round" />
      <path d="M6 32l4-4M6 32l4 4" stroke="#8C867D" strokeWidth="2" strokeLinecap="round" />
      <path d="M58 32l-4-4M58 32l-4 4" stroke="#8C867D" strokeWidth="2" strokeLinecap="round" />
      {/* botón central */}
      <circle cx="32" cy="32" r="17" fill="#2B2826" stroke="#3A3633" strokeWidth="1.5" />
      <rect x="23.5" y="23.5" width="17" height="17" rx="1.5" fill="none" stroke="#F2EEE7" strokeWidth="2" />
      <rect x="27" y="27" width="10" height="10" rx="1" fill="none" stroke="#F2EEE7" strokeWidth="2" />
    </svg>
  );
}
