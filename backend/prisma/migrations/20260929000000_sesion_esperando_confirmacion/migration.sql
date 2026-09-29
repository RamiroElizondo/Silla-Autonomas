-- El pago directo (silla libre) ahora también da una ventana para sentarse y
-- confirmar antes de encender la silla, igual que el flujo de la cola.
ALTER TYPE "EstadoSesion" ADD VALUE 'ESPERANDO_CONFIRMACION';
