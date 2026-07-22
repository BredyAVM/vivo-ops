# Handoff Counter / Mostrador - VIVO Ops - 2026-07-22

Este documento es para abrir un chat nuevo enfocado exclusivamente en terminar el modulo Counter / Mostrador.

## Estado actual

- Repo local: `C:\Users\bredy\Desktop\vivo-suite\vivo-ops`
- Ruta del modulo: `/app/counter`
- Archivos principales:
  - `src/app/app/counter/page.tsx`
  - `src/app/app/counter/CounterClient.tsx`
  - `src/app/app/counter/actions.ts`
- Ultimo commit visto antes de crear este handoff:
  - `5169c90 Fix dashboard search by short order number`
- Commits recientes relevantes del counter:
  - `d00bf1a Add counter cash and POS closure flow`
  - `017da0f Compact counter order detail view`
  - `69dd572 Align counter quick sale order details`
  - `7638858 Improve counter live updates and filters`
  - `a11bd7f Auto refresh counter on ready orders`
  - `c07c988 Improve counter order search and account balances`
  - `e36412e Show complete counter cash balances`
  - `8e18c7c Unify counter product composition semantics`
  - `b36b6de Allow advisor-responsible counter deliveries`
  - `de340a3 Align counter quick sale with master order flow`
  - `6c529fe Refine counter order workspace`
  - `0776e6e Simplify counter operational workspace`

## Documentos canonicos que debe leer el proximo chat

Antes de tocar el modulo, leer:

- `docs/HANDOFF_2026-07-22.md`
- `docs/OPERATIONAL_DATA_FRESHNESS_POLICY_2026-07-17.md`
- `docs/FINANCIAL_CANONICAL_FLOW_2026-06-04.md`
- `docs/FINANCIAL_GOVERNANCE_POLICY_2026-06-16.md`
- `docs/MASTER_ADMIN_SEPARATION_AUDIT_2026-07-17.md`

Regla importante:

```text
Counter es una caja registradora operativa.
No es master, no es administracion y no debe convertirse en dashboard financiero.
```

## Competencias canonicas del counter

Counter / Mostrador debe encargarse de:

1. Ver pedidos listos para pickup.
2. Ver pedidos listos para entregar a motorizado.
3. Consultar pedidos que aun estan en cocina cuando un cliente pregunta.
4. Buscar en la agenda general por numero corto de orden, nombre o telefono.
5. Crear venta directa presencial.
6. Crear pedido para otro momento, dejandolo agendado para que master lo envie a cocina cuando corresponda.
7. Cobrar pedidos presenciales con flujo tipo caja registradora.
8. Registrar pagos mixtos.
9. Entregar cambio desde una o varias cajas.
10. Dejar excedente en fondo del cliente cuando aplique.
11. Agregar productos a una orden activa cuando el cliente pida algo mas.
12. Entregar pickup.
13. Entregar pedido al motorizado y preguntar ETA al motorizado antes de marcar en camino.
14. Liquidar retorno de delivery cuando el motorizado regrese con dinero.
15. Registrar ingresos/egresos operativos solo de las cajas DAR y puntos habilitados.
16. Cerrar caja/punto operativo cuando corresponda.

## Lo que counter NO debe hacer

- No debe cargar ni mostrar todas las cuentas bancarias.
- No debe mostrar estados de cuenta completos.
- No debe manejar conciliaciones bancarias.
- No debe aprobar pagos bancarios como pago movil, transferencia o zelle.
- No debe ver configuraciones administrativas de cuentas.
- No debe cargar reportes pesados.
- No debe reemplazar al master.
- No debe modificar asignaciones de delivery como master, salvo la accion operativa de entregar al motorizado cuando ya este asignado.

## Reglas de dinero y permisos

Counter puede reportar pagos de cualquier metodo permitido por reglas, pero:

- Efectivo y punto pueden auto-confirmarse si la regla de cuenta lo permite.
- Pago movil, transferencia, zelle y bancos deben quedar como reportes pendientes para confirmacion de master/admin.
- Counter solo debe mover directamente cajas DAR y puntos.
- Los saldos de caja/punto deben reflejar todos los movimientos confirmados de la cuenta, sin importar si los hizo master, admin o counter.
- `money_movements` es la fuente de verdad contable.
- `payment_reports` es reporte/evidencia, no dinero confirmado por si solo.
- Solo `money_movements.status = confirmed` afecta saldos.

## Cuentas operativas del counter

La pantalla debe mostrar solo:

- Caja DAR USD.
- Caja DAR VES.
- Puntos de venta activos que el counter usa.

Debe mostrar:

- saldo real/sistema actual de cada caja/punto;
- entradas del dia;
- salidas del dia;
- movimientos del dia;
- quien registro cada movimiento;
- cierre operativo.

No debe mostrar:

- BDV Juridico, BNC Juridico, BDV Bredy, Zelle, Binance, Paypal, Retenciones u otras cuentas administrativas como estado de cuenta.

Counter puede reportar pagos hacia esas cuentas si la regla lo permite, pero no debe administrarlas.

## Estado tecnico actual

### `page.tsx`

La pagina esta marcada como dinamica:

- `dynamic = 'force-dynamic'`
- `revalidate = 0`
- usa `noStore()`

Carga inicial actual:

- perfil del usuario;
- pedidos operativos;
- cuentas activas;
- reglas de pago para rol `counter`;
- productos activos;
- tasa activa;
- items de ordenes visibles;
- estado financiero con `get_orders_financial_state`;
- reportes de pago;
- drivers, asesores y partners ligados a las ordenes visibles;
- movimientos confirmados del dia para cuentas directas del counter;
- snapshots de saldo de cuentas directas;
- componentes de productos.

La carga esta pensada para ser operativa, pero debe seguir vigilada para evitar peso innecesario.

### `actions.ts`

Acciones server existentes:

- `createCounterQuickSaleAction`
  - crea venta directa o agendada desde mostrador;
  - usa productos activos;
  - calcula precios con `calculateOrderLineSnapshot` y `calculateOrderTotalsSnapshot`;
  - crea cliente si hace falta;
  - si es venta inmediata, debe enviar a cocina;
  - si es agenda, queda creada para gestion posterior del master.

- `addCounterOrderItemsAction`
  - agrega productos a orden activa;
  - si la orden estaba lista, debe regresar a cocina para preparar lo nuevo;
  - debe conservar semantica de productos/componentes igual que master.

- `createCounterCashMovementAction`
  - registra ingreso/egreso operativo en caja/punto permitido;
  - solo cajas DAR y puntos;
  - queda confirmado si el usuario tiene permiso.

- `createCounterCashClosureAction`
  - registra cierre/arquo operativo de caja o punto;
  - cajas y puntos deben cerrar sin diferencia;
  - si hay diferencia, primero se debe registrar movimiento/ajuste que la explique.

- `searchCounterClientsAction`
  - busca clientes por telefono o nombre.

- `searchCounterAgendaAction`
  - busca ordenes en agenda/general por numero corto, ubicador, cliente o telefono.

### `CounterClient.tsx`

Componentes/zonas importantes:

- `CounterClient`
  - layout principal;
  - header con `Nueva venta`, `Caja`, `Buscar orden`, `Alertas`, `Actualizar`;
  - lista izquierda de pedidos;
  - panel derecho de trabajo.

- `CounterCashPanel`
  - cajas y puntos;
  - movimientos del dia;
  - registro de ingreso/egreso;
  - cierre de caja/punto.

- `MasterAgendaSearchPanel`
  - busqueda bajo demanda en agenda/general.

- `CounterQuickSalePanel`
  - crear venta directa;
  - buscar/crear cliente;
  - pickup/delivery;
  - agendar o crear ahora;
  - productos, combos/configurables;
  - pago esperado;
  - descuento, factura, nota de entrega y receptor.

- `OrderDetail`
  - detalle operativo de la orden seleccionada;
  - pedido, pago esperado, entrega, liquidacion de delivery, notas;
  - accion primaria;
  - agregar productos;
  - pago/retorno.

- `CounterAddItemsBox`
  - agregar productos a una orden existente;
  - usa componentes y configuracion de productos.

- `CounterPaymentBox`
  - pagos mixtos;
  - varias lineas de pago;
  - varias lineas de cambio;
  - decide entre fondo del cliente y entregar cambio;
  - permite entregar mas cambio que el excedente, dejando pendiente en la orden.

## Helpers compartidos que debe reutilizar

No duplicar logica si ya existe en:

- `src/lib/orders/order-labels.ts`
- `src/lib/orders/order-money.ts`
- `src/lib/orders/order-composer.ts`
- `src/lib/orders/whatsapp-summary.ts`
- `src/lib/pricing/order-snapshots.ts`
- `src/lib/payments/payment-report-rules.ts`
- `src/lib/domain/order-domain.ts`
- `src/lib/domain/finance-domain.ts`
- `src/lib/domain/delivery-domain.ts`
- `src/lib/finance/account-balances.ts`

Importante:

- El numero operativo es siempre el corto: `orders.id`.
- `order_number` largo no debe reemplazar al numero corto en UI.
- El formato WhatsApp debe salir de `src/lib/orders/whatsapp-summary.ts` si se agrega copiar WS al counter.
- La semantica de productos configurables, combos y detalles debe venir de `order-composer`.

## Decisiones operativas ya conversadas

### Flujo de pedidos

- Si el cliente llega por un pickup listo, counter ubica la orden y entrega.
- Si esta pagado, entrega y marca retirado.
- Si esta pendiente pero el pago esperado no es efectivo/punto, puede entregarse pendiente porque el asesor asume el cobro.
- Si el pago esperado es efectivo o punto, debe cobrar antes de entregar.

### Delivery

- Cuando una orden delivery esta lista y tiene motorizado/partner asignado, counter la entrega al motorizado.
- Antes de marcarla en camino, debe preguntar ETA al motorizado.
- Si no tiene motorizado/partner asignado, no debe salir; se avisa al master.
- Cuando el motorizado regresa con dinero, counter liquida el retorno/cobro.
- Si el delivery trae cambio, el egreso de cambio debe estar reflejado desde caja.

### Venta directa

- Si el cliente compra para ahora, counter crea la orden y la envia a cocina sin aprobacion de master.
- Si el cliente compra para otro momento, counter crea agenda; master luego gestiona el envio a cocina.
- Crear pedido debe parecerse al flujo del master/asesor, no a una logica nueva.
- Productos activos solamente.
- Deben funcionar combos, platos/configurables, descuentos, factura, nota de entrega, receptor y direccion/GPS.

### Busqueda

- El buscador de la lista izquierda solo filtra lo visible.
- El boton `Buscar orden` consulta agenda/general bajo demanda.
- Debe buscar por numero corto, nombre de cliente y telefono.
- Sirve para cuando el cliente llega o pregunta por una orden que no aparece en la vista principal.

### Cajas y puntos

- Counter ve cajas DAR y puntos.
- No ve bancos como estados de cuenta.
- Si reporta pago movil/transferencia/zelle, eso queda para master/admin.
- El saldo de caja/punto debe incluir movimientos de cualquier rol.
- Cajas y puntos se cierran sin diferencia; si hay diferencia, primero se registra ajuste/movimiento que la explique.

## Pendientes y puntos a revisar

### 1. Refinamiento visual operativo

El usuario quiere una pantalla 100% operativa:

- no saturar con muchos filtros;
- evitar tarjetas/resumenes que no se usan;
- mantener siempre lista izquierda + panel derecho;
- al abrir `Nueva venta`, la lista izquierda debe seguir visible;
- al seleccionar una orden, el pedido debe verse primero y facil de leer;
- las acciones no deben ocupar demasiado protagonismo;
- los filtros deben ser solo los realmente utiles.

Revisar especialmente:

- filtros actuales;
- secciones de pedidos;
- tamano de `CurrentActionCard`;
- visibilidad del pedido seleccionado;
- si `Caja` y `Buscar orden` tienen protagonismo adecuado.

### 2. Flujo de cobro tipo caja registradora

Debe quedar muy facil:

- varias lineas de pago;
- varias cuentas;
- cambio desde varias cajas;
- excedente a fondo;
- cambio entregado de mas deja saldo pendiente en la orden, no deuda negativa del cliente;
- pagos bancarios quedan pendientes de revision;
- efectivo/punto auto-confirman si regla lo permite.

Validar que no haya calculos locales contradictorios con el estado financiero canonico.

### 3. Liquidacion de delivery

Validar end-to-end:

- orden lista;
- entrega a motorizado;
- pregunta ETA;
- marca en camino;
- retorno con pago;
- cambio si aplica;
- marca entregada;
- saldos de orden y caja/punto quedan correctos.

### 4. Cierre de caja/punto

Validar:

- saldo inicial visible;
- movimientos del dia;
- ingresos/egresos de master/admin/counter incluidos;
- cierre sin diferencia;
- si hay diferencia, mensaje claro;
- no generar traspaso automatico de punto al banco en el cierre, porque se decidio registrar/vincular traspaso despues cuando caiga en banco.

Nota: algunos documentos financieros antiguos aun dicen que POS genera traspaso automatico. La decision operativa posterior fue separar cierre de punto y traspaso bancario.

### 5. Crear venta directa y agregar items

Validar contra master:

- busqueda de cliente por nombre/telefono;
- crear cliente nuevo;
- productos activos;
- precios nuevos y tasa activa;
- productos nacidos en USD/VES;
- productos configurables;
- combos y componentes;
- descuentos;
- factura/nota de entrega;
- receptor distinto;
- delivery y pickup;
- orden para ahora vs agenda.

### 6. Datos frescos y costos Vercel

Counter debe actualizar datos vivos, pero sin ser pesado:

- pedidos activos pueden refrescarse automaticamente;
- busqueda historica/agenda debe ser bajo demanda;
- caja/punto debe refrescarse al abrir o con boton;
- catalogo puede cachearse, pero la accion final valida en servidor;
- no cargar historicos largos al abrir.

### 7. Push y sonido

Debe revisarse:

- si counter recibe push cuando cocina marca un pedido listo;
- si la pantalla refresca al llegar una orden lista;
- si hay sonido o alerta clara para nuevas acciones.

## Escenarios de prueba recomendados

Probar antes de dar por cerrado:

1. Pickup listo, pagado, marcar retirado.
2. Pickup listo, pendiente por efectivo, intentar entregar sin cobrar debe bloquear.
3. Pickup listo, pendiente por pago movil/transferencia, puede entregar pendiente del asesor/master.
4. Delivery listo sin motorizado, debe bloquear salida.
5. Delivery listo con motorizado, preguntar ETA y marcar en camino.
6. Delivery en camino con cobro pendiente, registrar retorno y marcar entregado.
7. Pago mixto: parte efectivo USD, parte punto VES.
8. Pago con excedente a fondo.
9. Pago con cambio parcial desde USD y VES.
10. Cambio entregado de mas, la orden queda con pendiente por diferencia.
11. Nueva venta ahora: crea orden y cocina la ve.
12. Nueva venta agendada: queda en `created` para master.
13. Agregar item a orden lista: vuelve a cocina.
14. Busqueda agenda por numero corto de orden vieja.
15. Busqueda agenda por nombre con acento/sin acento si aplica.
16. Caja DAR muestra movimientos hechos por master y admin.
17. Cierre de caja/punto con diferencia cero.
18. Cierre de caja/punto con diferencia muestra error claro.

## No regresion

- No tocar `/app/master/dashboard` mientras se refine counter, salvo bug puntual solicitado.
- No duplicar helpers canonicos.
- No usar el ubicador largo como numero principal.
- No permitir que counter confirme pagos bancarios.
- No mostrar bancos como estado de cuenta del counter.
- No guardar deuda negativa en fondo del cliente.
- No hacer que el cierre de punto transfiera automaticamente al banco.
- No cargar movimientos historicos por defecto.

## Siguiente bloque recomendado para el chat nuevo

1. Revisar visualmente `/app/counter` contra estas reglas.
2. Ajustar filtros y layout para que la pantalla sea mas operativa.
3. Validar `OrderDetail`: pedido primero, acciones compactas.
4. Revisar caja/punto: saldo completo, movimientos de todos los roles, cierre claro.
5. Probar flujo de cobro/liquidacion completo.
6. Solo despues, afinar push/sonido y busqueda agenda.

## Prompt sugerido para abrir el chat nuevo

```text
Quiero continuar especificamente con el modulo Counter / Mostrador de Vivo Ops.

Repo: C:\Users\bredy\Desktop\vivo-suite\vivo-ops

Antes de tocar codigo, lee docs/HANDOFF_COUNTER_2026-07-22.md y los documentos canonicos que menciona.

Objetivo: terminar /app/counter como caja registradora operativa: pedidos listos, entrega pickup, entrega a motorizado, liquidacion de delivery, cobros mixtos, cambios, caja/puntos y venta directa, sin convertirlo en dashboard financiero ni tocar /app/master/dashboard.
```

