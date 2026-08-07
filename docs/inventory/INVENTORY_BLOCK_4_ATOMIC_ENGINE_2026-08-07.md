# Bloque 4: motor atómico de inventario

Fecha: 2026-08-07

Estado: aplicado y verificado en Supabase; sin apertura de saldos ni activación de ventas o recetas.

## Resultado

Se instaló el primer motor canónico sobre la estructura existente. No se creó
ninguna tabla ni columna de negocio nueva. Se reutilizaron:

- `inventory_items.current_stock_units` como proyección de saldo;
- `inventory_movements` como kardex físico;
- `inventory_movements.operation_id` como clave idempotente común;
- `inventory_movements.reversal_of_movement_id` para reversos;
- `inventory_counts` e `inventory_count_lines` para conteos y reconteos;
- `inventory_recipes` e `inventory_recipe_components` para transformaciones.

La única estructura técnica nueva es el esquema privado `app_private`, no
expuesto a la API, donde viven los auxiliares que actualizan el kardex y el saldo
dentro de una misma transacción.

## Comandos instalados

| Comando | Autoridad |
| --- | --- |
| Apertura física de un ítem | Administración |
| Entrada de mercancía o devolución de evento | Cocina o Administración |
| Avería, merma o prueba de calidad | Cocina o Administración |
| Ajuste administrativo a cantidad objetivo | Administración |
| Ejecución de receta | Cocina o Administración |
| Reverso completo de una operación | Administración |
| Presentación de conteo | Cocina o Administración |
| Aceptación o reconteo selectivo | Master o Administración |

Todos los comandos exigen usuario autenticado, validan el rol dentro de la
función, reciben una clave UUID idempotente y bloquean las filas afectadas antes
de escribir.

## Invariantes

- Los movimientos canónicos usan cantidades con signo: entradas positivas y
  salidas negativas.
- Los 3.905 movimientos heredados conservan su semántica y permanecen intactos.
- Una operación reintentada con el mismo UUID devuelve el resultado ya aplicado.
- Una receta insuficiente falla completa y no deja movimientos parciales.
- Las pérdidas, recetas y reversos no pueden dejar una existencia negativa.
- Los movimientos canónicos son inmutables; una corrección agrega un reverso.
- Después de la apertura, el saldo del ítem solo puede cambiar mediante el motor.
- La apertura parte del conteo físico y no de la cifra heredada del sistema.

## Conteos

El conteo ajusta de inmediato la disponibilidad a la cantidad realmente contada.
Luego Master ve el encabezado y sus líneas, y puede:

- aceptar el conteo completo;
- solicitar reconteo únicamente de las líneas dudosas;
- aceptar el reconteo posterior.

El movimiento físico no espera aprobación de Master: la revisión conserva la
responsabilidad del usuario que contó sin ocultar la diferencia encontrada.

## Frontera deliberada

La migración no realizó una apertura física y por eso el estado vivo continúa en:

- 77 ítems de inventario;
- 0 ítems abiertos en el motor canónico;
- 3.905 movimientos heredados y 0 movimientos canónicos;
- 15 recetas, de las cuales solo las 2 heredadas continúan activas;
- 13 recetas canónicas todavía inactivas.

Tampoco se conectó el comando heredado de entrega de Master, Cocina, Counter ni
el asesor. El consumo por venta necesita primero resolver cada producto,
composición y selección real a líneas físicas; esa integración será el siguiente
bloque y no interpretará nombres ni notas libres.

## Seguridad

Se retiraron todos los privilegios del rol `anon` sobre las diez tablas del
dominio. Los siete RPC públicos son `SECURITY DEFINER` de forma intencional para
aplicar una transacción única pese a las políticas RLS; todos usan
`search_path = ''`, rechazan `anon`, validan `auth.uid()` y comprueban el rol en
`user_roles`. Los auxiliares privados no tienen ejecución ni uso para `anon` o
`authenticated`.

## Verificación

- migraciones:
  - `20260807175917_inventory_atomic_engine_v1.sql`;
  - `20260807183124_inventory_read_access_hardening.sql`;
  - `20260807183841_inventory_opening_command_cleanup.sql`;
- pruebas completas dentro de transacciones seguidas de `ROLLBACK`;
- apertura, replay, entrada, pérdida, ajuste, reverso y receta verificados;
- receta sin stock verificada sin movimientos parciales;
- conteo, aceptación y reconteo selectivo verificados;
- apertura individual duplicada retirada: toda apertura deja encabezado y líneas
  de conteo;
- escrituras directas de saldo y kardex canónico rechazadas;
- restricciones, disparadores, permisos e índice idempotente verificados en vivo;
- huellas de saldos y movimientos idénticas antes y después;
- compilación de producción y lint completados correctamente.

## Visibilidad

La ruta `/app/inventory/operations` muestra el estado del motor, aperturas,
conteos pendientes y movimientos canónicos recientes. Es una Server Component:
no añade peso a la dashboard y solo consulta Supabase cuando se abre esa ruta.
