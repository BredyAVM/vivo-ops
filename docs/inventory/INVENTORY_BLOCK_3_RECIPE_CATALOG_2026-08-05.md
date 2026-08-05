# Bloque 3: recetas y cierre técnico del catálogo

Fecha: 2026-08-05

Estado: aplicado y verificado en Supabase; recetas canónicas no ejecutables.

## Resultado

Se prepararon 13 recetas canónicas:

| Familia | Recetas | Tiempo |
| --- | ---: | ---: |
| Prefritos | 6 | 240 minutos |
| Salsa tártara | 5 | inmediato |
| Mostaza miel | 2 | inmediato |

Los prefritos producen un servicio almacenado desde piezas crudas:

- mini tequeños: 25 piezas → 1 servicio;
- empanadas: 20 piezas → 1 servicio;
- cachitas: 20 piezas → 1 servicio;
- mandocas: 25 piezas → 1 servicio;
- bombys: 25 piezas → 1 servicio;
- tequeños regulares: 5 piezas → 1 servicio bajo demanda.

La tártara conserva el recipiente tipo kilo como unidad fraccionable. Su
porcionado usa el rendimiento conservador acordado: 8 de 5 oz, 20 de 2 oz o 40
de 1 oz. La preparación base consume 1 kg de mayonesa y 0,050 kg de menjurje por
recipiente equivalente; el rendimiento físico real se declarará al producir.

Se creó únicamente el ítem interno que faltaba: `Aderezo Mostaza Miel a granel
(envase 1 kg)`. No se creó una tabla ni un producto comercial nuevo. Sus recetas
producen 8 porciones de 5 oz o 20 de 2 oz.

## Cinco pendientes cerrados

- Mostaza Miel 2 oz: lista con receta.
- Mostaza Miel 5 oz: lista con receta.
- `Pack para Eventos`: renombrado `Evento personalizado`, sin límite total y con
  las cinco familias fritas seleccionables.
- `Pack para Colegios`: conservado como histórico y no inventariable.
- Empanada de cerdo estacional: corregida a `Empanadas Pulled Pork Fritas (20
  und)` contra `Empanadas Pulled Pork Crudas`, bolsa de 100.

El producto crudo fabricado para el restaurante no existe en el catálogo vivo y
no se creó por chat. Se incorporará mediante el configurador universal.

## Límite deliberado

La auditoría encontró que Master ya ejecuta recetas activas mediante múltiples
escrituras no atómicas. Para no cambiar esa operación:

- las 13 recetas canónicas tienen `is_active = false`;
- las 2 recetas heredadas siguen activas e intactas;
- no se modificó código de Master, Cocina, Counter, Asesor ni Finanzas;
- no se insertaron movimientos ni se ajustaron saldos;
- los 103 enlaces canónicos de producto continúan inactivos.

## Verificación

- migración: `20260805171625_inventory_recipe_catalog_staging.sql`;
- prueba completa en transacción seguida de `ROLLBACK`;
- 143 productos, todos en estado `ready`;
- 77 ítems físicos y una presentación para la mostaza miel de 1 kg;
- 15 recetas totales: 13 canónicas inactivas y 2 heredadas activas;
- 18 componentes de receta;
- 234 componentes comerciales;
- 107 enlaces heredados activos y cero enlaces canónicos activos;
- huellas de saldos, movimientos y configuración heredada conservadas;
- asesores de Supabase sin alertas nuevas causadas por este bloque; permanecen
  las advertencias legadas de exposición y políticas permisivas.

## Visibilidad

La ruta `/app/inventory/recipes` muestra insumos, rendimientos, tiempos,
múltiplos y estado. Solo consulta estos datos cuando el usuario entra a la ruta.
