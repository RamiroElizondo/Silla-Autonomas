/**
 * Cache TTL en memoria con coalescing de pedidos concurrentes, para los
 * endpoints públicos de "estado" (silla, sesión, turno, resumen de cola) que
 * sondean el celular del cliente y la pantalla TV del local — ver
 * `common/cache.config.ts` para el TTL que usan.
 *
 * Igual que el resto del estado en memoria de este proyecto (ver
 * `FallosCanjeService`, `common/throttle.config.ts`): vive en el proceso,
 * es de una sola instancia y no sobrevive un reinicio. No hace falta que lo
 * haga para este despliegue de un solo servidor; si algún día se corre más
 * de una instancia, esta cache dejaría de servir para nada y habría que
 * reemplazarla por algo compartido (ej. Redis).
 */
interface Entrada<T> {
  vence: number; // epoch ms
  promesa: Promise<T>;
}

export class TtlCache<T> {
  private readonly entradas = new Map<string, Entrada<T>>();

  constructor(private readonly ttlMs: number) {}

  /**
   * Devuelve el valor cacheado para `key` si sigue vigente. Si venció (o
   * nunca se cargó), llama a `cargador()` UNA sola vez — incluso si varios
   * pedidos llegan concurrentemente para la misma key antes de que resuelva
   * (coalescing): se guarda y comparte la promesa en curso, no el valor ya
   * resuelto.
   *
   * Un `cargador()` que rechaza NUNCA queda cacheado: se saca la entrada
   * (si nadie la invalidó o reemplazó mientras tanto) para que el próximo
   * pedido reintente de cero. Los pedidos concurrentes que ya recibieron
   * esta misma promesa reciben el mismo rechazo — coalescing también se
   * aplica al error, no solo al éxito.
   */
  async obtenerOCargar(key: string, cargador: () => Promise<T>): Promise<T> {
    const vigente = this.entradas.get(key);
    if (vigente && vigente.vence > Date.now()) {
      return vigente.promesa;
    }

    const promesa = cargador();
    const entrada: Entrada<T> = { vence: Date.now() + this.ttlMs, promesa };
    this.entradas.set(key, entrada);

    // Reacción de limpieza aparte de lo que haga el que llama con el
    // rechazo: no le cambia el resultado a nadie, solo evita que quede
    // cacheado. Comparamos por identidad de la entrada para no pisar una
    // carga más nueva que haya llegado mientras esta estaba en vuelo
    // (invalidar() + una carga fresca, por ejemplo).
    promesa.catch(() => {
      if (this.entradas.get(key) === entrada) {
        this.entradas.delete(key);
      }
    });

    return promesa;
  }

  /** Saca `key` de la cache: el próximo `obtenerOCargar` recarga de cero. */
  invalidar(key: string): void {
    this.entradas.delete(key);
  }
}
