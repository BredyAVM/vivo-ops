# Auditoría final del Bloque 4 - Motor de caja registradora

Fecha: 2026-07-25

Alcance: `/app/counter`, RPC financieros necesarios y su modelo de lectura.

## Resultado

El Bloque 4 queda cerrado. Counter registra pagos simples, mixtos y parciales,
cambio en efectivo, cambio digital pendiente, remanentes al fondo del cliente y
devoluciones autorizadas mediante intenciones atómicas e idempotentes.

No se modificó ningún archivo de `/app/master/dashboard`.

## Modelo reutilizado

No se creó un ledger financiero paralelo:

- `payment_reports` conserva pagos pendientes, confirmados o rechazados;
- `money_movements` conserva únicamente dinero confirmado;
- `client_fund_movements` conserva el fondo del cliente;
- `counter_command_receipts` conserva idempotencia y comprobantes;
- `order_timeline_events` conserva trazabilidad y responsables.

La única tabla nueva es `order_change_obligations`. Representa cambio digital
que todavía se debe al cliente y, por tanto, no puede registrarse aún como una
salida confirmada de dinero.

## Contrato implementado

- Varias líneas de pago por operación.
- Efectivo USD/VES y POS habilitados por las reglas de cuenta.
- Pagos digitales registrados como pendientes de revisión.
- Cambio en efectivo desde cajas DAR.
- Cambio combinado entre efectivo y una obligación digital.
- Cambio válido aunque el pago sea solamente un abono de la orden.
- Excedente restante al fondo del cliente.
- Vista previa antes de confirmar y comprobante posterior.
- Una misma clave de idempotencia se conserva durante el reintento.
- Pago digital pendiente con asesor no bloquea por sí solo la entrega.
- Pago digital pendiente sin asesor requiere confirmación de Master.
- Solicitud de devolución limitada al saldo a favor realmente disponible.
- Devolución ejecutable por Counter únicamente después de aprobación.
- Una devolución confirmada reduce el estado financiero de la orden.

## Migraciones remotas

- `20260725234348_counter_block4_register_engine`
- `20260725234507_counter_block4_hardening`
- `20260725234706_counter_block4_refund_guard`
- `20260726202857_counter_block4_financial_search_path`

## Seguridad

- Los RPC de pago y devolución son `SECURITY DEFINER`.
- Cada RPC valida `auth.uid()` y rol `counter`, `master` o `admin`.
- `PUBLIC` y `anon` no tienen `EXECUTE`.
- Los primitivos internos de Bloque 2 no son ejecutables por
  `authenticated`.
- `order_change_obligations` tiene RLS, no concede acceso directo a
  `authenticated` y solo se escribe mediante el RPC.
- Todas las funciones nuevas y heredadas utilizadas por este bloque tienen
  `search_path` fijado.

El advisor de Supabase conserva dos avisos intencionales:

1. RLS sin policy en `order_change_obligations`: funciona como denegación total
   del acceso directo; el RPC validado es la única entrada.
2. RPC `SECURITY DEFINER` ejecutable por `authenticated`: es necesario para el
   Counter puro y el control de rol ocurre dentro de cada función.

Los índices de la tabla nueva aparecen como no utilizados porque todavía no
existen filas de producción. No hay índices duplicados introducidos por el
bloque.

## Pruebas transaccionales

Todas las pruebas utilizaron un usuario con únicamente rol Counter. Las órdenes,
pagos, movimientos y obligaciones de prueba se crearon dentro de transacciones
y terminaron en `ROLLBACK`.

Casos aprobados:

- pago mixto con efectivo confirmado y Zelle pendiente;
- pago parcial con cambio en efectivo superior al excedente de la orden;
- saldo resultante exacto después del cambio;
- reintento idempotente con un solo comprobante;
- pago con cambio combinado efectivo/digital;
- obligación digital persistida exactamente una vez;
- remanente exacto al fondo del cliente;
- detalle de orden con cambio digital y responsable;
- rechazo de devolución superior al saldo a favor;
- solicitud idempotente de devolución;
- aprobación por Master;
- ejecución por Counter;
- reducción exacta del saldo a favor después de devolver.

La auditoría posterior confirmó cero artefactos de prueba persistidos.

## Rendimiento observado

Medido en Supabase con `EXPLAIN (ANALYZE, BUFFERS)` y sesión Counter:

| Lectura | Tiempo observado |
| --- | ---: |
| Cola activa, hasta 120 órdenes | 26,953 ms |
| Detalle financiero de una orden | 12,928 ms |

La cola no carga obligaciones ni autorizaciones de cada orden. Esa información
se agrega únicamente al abrir el detalle seleccionado.

## Verificación de código

- `npx tsc --noEmit --incremental false --pretty false`: aprobado.
- ESLint focalizado de los componentes y modelo nuevos: aprobado.
- `npm run build`: aprobado con Next.js 16.2.6.
- Revisión React: estado local derivado, claves estables, botones semánticos y
  separación del motor de pago y la devolución en componentes propios.

El lint completo de `counter/actions.ts` conserva cuatro usos históricos de
`any` fuera de las líneas añadidas por este bloque.

## Siguiente bloque

Bloque 5 - Pickup operativo.

Debe reutilizar este motor sin reabrir el diseño financiero y concentrarse en
modificación permitida por estado, autorización de pedidos listos y entrega
física del pickup.
