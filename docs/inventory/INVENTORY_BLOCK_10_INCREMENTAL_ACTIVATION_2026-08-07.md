# Bloque 10: apertura y activación incremental

Fecha: 2026-08-07

## Resultado

Administración dispone de una cola en `/app/inventory/configure` que convierte los
borradores del Bloque 9 en configuraciones operativas sin activar existencias a
ciegas ni cambiar de golpe el modo global del inventario.

El flujo canónico queda así:

1. guardar el producto o ítem como borrador inactivo;
2. presentar un conteo físico inicial cuando el ítem controla existencia;
3. permitir que Master o administración acepten el conteo o soliciten un reconteo;
4. mantener el ítem inactivo mientras exista una revisión pendiente;
5. validar enlaces, componentes, política y aperturas;
6. activar atómicamente el producto, sus vínculos y los ítems físicos nuevos.

Los productos `none` no requieren apertura. Los productos `self` y `direct`
requieren que cada ítem transaccional o de conteo periódico tenga una apertura
aceptada. Los productos `components` solo se activan cuando sus componentes ya
están activos y validados.

## Reutilización de estructura

No se crearon tablas, columnas ni un segundo saldo. El bloque reutiliza:

- `products` y `inventory_configuration_status`;
- `inventory_items` y `current_stock_units`;
- `product_inventory_links`;
- `product_components`;
- `inventory_counts` e `inventory_count_lines`;
- `inventory_movements` y su idempotencia por `operation_id`.

La apertura incremental y sus reconteos producen movimientos canónicos de conteo.
No existe una tabla paralela de borradores, activaciones o saldos.

## Reglas de seguridad

- solo `admin` consulta la cola, presenta aperturas de borradores y activa;
- Master conserva la revisión: acepta o solicita reconteos;
- cocina puede completar un reconteo cuando la solicitud le corresponde;
- un borrador transaccional no se activa sin apertura aceptada;
- un reconteo aceptado cierra también la apertura de la cual desciende;
- una apertura de un ítem inactivo no cambia `legacy/opening/canonical` global;
- si el catálogo ya estuviera canónico, una activación no puede devolverlo a
  apertura;
- las funciones privilegiadas validan `auth.uid()` y rol, usan `search_path = ''`,
  revocan `PUBLIC/anon` y solo exponen ejecución a `authenticated`.

## Efecto sobre órdenes y otros módulos

Este bloque no cambia Master, Counter, Cocina ni Finanzas. La pantalla vive en el
dominio independiente de inventario y se consulta únicamente al abrir la ruta de
configuración.

No se instaló ninguna prohibición de venta. La apertura global real continúa
pendiente y el catálogo existente conserva su modo previo, por lo que las órdenes
actuales siguen sin bloqueo por inventario.

## Verificación

La migración `20260808004429_inventory_incremental_activation_v1` fue aplicada en
Supabase. El catálogo vivo terminó igual que antes de las pruebas: 144 productos,
77 ítems, cero borradores, cero aperturas y cero fixtures de Block 10.

`INVENTORY_BLOCK_10_TRANSACTION_TESTS_2026-08-07.sql` prueba dentro de
`BEGIN/ROLLBACK`:

- permisos de administración y Master;
- rechazo de activación sin apertura;
- apertura inactiva y estabilidad del corte global;
- solicitud, presentación y aceptación de reconteo;
- activación de ítem independiente;
- activación de productos `self`, `direct`, `components` y `none`;
- diagnóstico y permanencia en cola de una configuración incompleta;
- ausencia de fixtures al finalizar.

## Siguiente fase

El siguiente bloque debe centrarse en la operación real de entradas de mercancía
y recepciones esperadas: Master proyecta lo esperado, cocina registra únicamente
lo recibido y el saldo usa la cantidad física efectiva. Debe conservar la misma
regla no bloqueante para las órdenes.
