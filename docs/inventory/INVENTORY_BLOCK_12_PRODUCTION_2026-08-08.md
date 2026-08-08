# Bloque 12: producción y transformaciones canónicas

Fecha: 2026-08-08

Estado: aplicado en Supabase; disponible en el Centro de Inventario sin activar
recetas ni saldos existentes.

## Regla operativa

- Una preparación siempre consume sus insumos físicos al iniciarse.
- Una receta inmediata acredita el rendimiento físico declarado en la misma
  transacción y crea su lote de producción.
- Una receta con tiempo de preparación crea un `planned_production`; durante el
  enfriamiento la salida no forma parte del stock disponible.
- Al llegar la hora disponible, Cocina o Administración declara el rendimiento
  físico real. Solo entonces se crea el lote y se acredita la salida.
- Una diferencia entre el rendimiento esperado y el real queda trazada y
  visible. No se corrige silenciosamente.
- Una producción fallida no inventa salida ni restaura automáticamente los
  insumos ya consumidos. Administración conserva el reverso explícito para una
  corrección de captura.

## Estructura reutilizada

No se creó una tabla de producción. Se reutilizaron:

- `inventory_recipes` e `inventory_recipe_components`;
- `inventory_planned_flows` con `flow_type = planned_production`;
- `inventory_lots` con `lot_kind = production`;
- `inventory_movements` para consumo y salida;
- `inventory_items.current_stock_units` como única proyección de saldo.

La relación ya existente `inventory_lots.planned_flow_id` ahora admite tanto la
conciliación de mercancía como la de producción y un trigger valida que el tipo
y el ítem coincidan.

## Permisos

- Administración activa una receta después de que todos sus ítems tengan una
  apertura aceptada.
- Cocina o Administración inicia, termina o reporta fallida una producción.
- Master consulta recetas, producciones en curso, horas disponibles y
  diferencias, pero no mueve stock.
- Asesor no accede al centro de producción.

## Frontera de seguridad

Las 13 recetas canónicas continúan inactivas y los 77 ítems continúan sin
apertura. Por eso la instalación no creó movimientos, lotes ni producciones y
no cambió ningún saldo. Las dos recetas heredadas siguen intactas.

Este bloque tampoco conecta ni bloquea órdenes. La política de ventas continúa
siendo no bloqueante y el Master conserva la decisión final.

## Verificación

- pruebas completas dentro de una transacción seguida de `ROLLBACK`;
- preparación inmediata con rendimiento físico variable;
- preparación diferida sin stock durante enfriamiento;
- rechazo de finalización anticipada;
- finalización con diferencia de rendimiento;
- producción fallida sin salida ficticia;
- idempotencia de inicio y finalización;
- permisos de Administración, Cocina, Master y Asesor;
- inventario y órdenes productivas sin mutaciones por la instalación.
