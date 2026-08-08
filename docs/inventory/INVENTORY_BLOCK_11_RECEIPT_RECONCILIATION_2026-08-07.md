# Bloque 11: recepciones esperadas y entradas reales

Fecha: 2026-08-07

## Resultado

El centro de inventario separa dos hechos que antes podían confundirse:

1. Master o administración declaran qué mercancía esperan y desde cuándo creen que estará disponible.
2. Cocina o administración registran únicamente lo que llegó físicamente.

La expectativa nunca aumenta el saldo real. La recepción crea el lote, registra el movimiento de entrada y aumenta el saldo en unidades base. Si se esperaban cinco bolsas y llegaron cuatro, entran cuatro; la expectativa queda cerrada con diferencia y la bolsa pendiente no se arrastra. Si después se espera otra bolsa, Master crea una expectativa nueva.

## Reutilización de estructura

No se creó una tabla de recepciones ni un saldo paralelo. El bloque reutiliza:

- `inventory_planned_flows` para expectativas;
- `inventory_item_presentations` para bolsas, cajas, paquetes y recipientes;
- `inventory_lots` para la mercancía recibida;
- `inventory_movements` para el asiento `inbound`;
- `inventory_items.current_stock_units` como saldo canónico.

Se agregaron solamente los datos que faltaban para unir y auditar esos hechos:

- `inventory_planned_flows.operation_id`, para idempotencia;
- `inventory_planned_flows.capture_details`, como foto validada de lo esperado;
- `inventory_lots.planned_flow_id`, como relación explícita con la expectativa;
- `inventory_lots.capture_details`, como foto validada de lo recibido.

La relación lote-expectativa es uno a uno porque una recepción real cierra completamente una expectativa. Las capturas guardan la presentación, el factor de conversión usado, las unidades sueltas y la fuente. El saldo conserva solo unidades base.

## Reglas canónicas

- Una expectativa puede tener cantidad conocida o desconocida.
- Una cantidad desconocida no aporta unidades a la disponibilidad proyectada.
- La recepción real siempre exige una cantidad exacta y comienza con el formulario vacío.
- Se aceptan varias presentaciones, unidades sueltas y una conversión puntual distinta a la predeterminada.
- La conversión aplicada queda congelada en el lote; cambiar después el catálogo no reescribe el pasado.
- Una recepción puede ser planificada o no planificada.
- Una diferencia positiva o negativa modifica el saldo por lo realmente recibido y cierra la expectativa como `failed` para conservar la anomalía visible.
- Una coincidencia exacta o una expectativa de cantidad desconocida se cierra como `fulfilled`.
- Cancelar o reemplazar una expectativa no cambia existencias.
- Repetir la misma operación idempotente no duplica expectativas, lotes, movimientos ni saldo.
- Un ítem requiere apertura aceptada antes de recibir mercancía real.

## Presentaciones recuperadas

La migración normaliza las presentaciones que ya estaban confirmadas en el catálogo: empaques heredados de materias primas, bolsa de Dondys, cajas de latas y Yukypack, y paquetes de seis para las bebidas en botella vigentes. No inventa consumibles nuevos. Cuando cambie una marca o contenido, administración podrá ajustar la presentación o usar una conversión puntual al recibir.

## Permisos

- Master: consultar, crear, reprogramar y cancelar expectativas.
- Cocina: consultar y registrar mercancía realmente recibida.
- Administración: ambas capacidades.
- Advisor, Counter, Driver y cualquier rol no autorizado: sin acceso a estos comandos ni a su modelo de lectura.

La pantalla actual vive en `/app/inventory/operations`, dominio que ya está reservado a Master y administración. Cocina no fue modificada: su futura pantalla usará exactamente el mismo comando de recepción, sin duplicar lógica.

## Efecto sobre órdenes y otros módulos

Este bloque no modifica Master Dashboard, Counter, Cocina ni Finanzas. Tampoco instala un bloqueo de venta o de creación de órdenes. Las expectativas alimentan la proyección que ya existía, pero el flujo actual de órdenes conserva la regla no bloqueante y el corte global de inventario no se altera.

## Verificación

La migración `20260808010959_inventory_receipt_reconciliation_v1` quedó aplicada en Supabase.
Después de las pruebas, producción conserva 144 productos, 77 ítems, 0 aperturas,
0 lotes, 0 entradas canónicas, 0 expectativas y 1.579 órdenes. Las presentaciones
normalizadas pasaron de 1 a 46 sin crear ítems ni consumibles nuevos.

`INVENTORY_BLOCK_11_TRANSACTION_TESTS_2026-08-07.sql` se ejecuta dentro de `BEGIN/ROLLBACK` y cubre permisos, cantidad desconocida, reemplazo, cancelación, recepción exacta, recepción con diferencia, recepción no planificada, conversiones congeladas e idempotencia. Al terminar no deja productos, ítems, aperturas, lotes, movimientos ni expectativas de prueba.

## Siguiente fase

El siguiente bloque debe trabajar la producción y transformación entre existencias: crudo a prefrito con disponibilidad diferida, preparaciones inmediatas de salsa y sus rendimientos, manteniendo el mismo motor de lotes y movimientos.
