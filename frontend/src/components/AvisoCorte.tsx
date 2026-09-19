/**
 * Corte de energía en curso. El mensaje evita pedirle nada al cliente: está
 * sentado en la silla, la ve apagada, y lo único que necesita saber es que
 * no perdió su tiempo ni su plata.
 */
export function AvisoCorte({ compensados }: { compensados?: string }) {
  return (
    <div className="mt-6 w-full rounded-2xl border border-arena bg-panal p-6 text-center">
      <p className="text-[15px] font-medium">Se cortó la luz</p>
      <p className="mt-2 text-sm text-tinta-suave">
        Tu tiempo quedó en pausa. Apenas vuelva, la silla se enciende sola y
        seguís donde estabas.
      </p>
      {compensados && (
        <p className="mt-3 text-xs text-tinta-muted">
          Ya te devolvimos {compensados}
        </p>
      )}
      <p className="mt-3 text-xs text-arena">
        Vas a tener que apretar el botón de la silla otra vez
      </p>
    </div>
  );
}
