# Bloque 19: apertura controlada con responsables reales

## Objetivo

Preparar la ejecución real de la apertura sin atribuir por SQL acciones a un
usuario que no las realizó. El flujo conserva tres responsables y momentos:

1. Administración presenta las 48 cantidades físicas desde su sesión.
2. Master abre el reporte completo, acepta o solicita reconteos selectivos.
3. Administración activa atómicamente las 13 recetas después de la aceptación.

Las órdenes continúan sin bloqueo. El inventario solo cambia de `legacy` a
`canonical` cuando las 48 líneas están aceptadas.

## Conteo certificado precargado

La ruta `/app/inventory/opening` precarga el conteo de cierre del 8 de agosto de
2026. La precarga contiene los 48 valores ya confirmados, incluido:

- Yukipack Manzana 14, Pera 14 y Durazno 22;
- aderezo a granel 0,25 del envase canónico de 1 kg;
- productos no reportados en el inventario de cierre con cantidad cero;
- cajas fuera del lote por pertenecer a conteo periódico.

Antes de precargar, el servidor compara cantidad de ítems, ID y nombre contra el
catálogo actual. Si cualquiera cambió, no presenta números y muestra una alerta.
Administración puede revisar y corregir cada valor antes de enviar.

## Revisión y activación

La aceptación sigue usando `inventory_review_count_v1`; no se creó una vía
alternativa. El usuario autenticado queda registrado como revisor.

La función nueva `inventory_activate_canonical_recipes_v1` no duplica recetas ni
tablas. Reutiliza `inventory_activate_recipe_v1` dentro de una sola transacción,
en orden estable y con bloqueo asesor. Solo Administración puede ejecutarla y
solo después de una apertura completa aceptada. Si una receta falla, ninguna de
las 13 queda activada por esa llamada.

## Auditoría temporal

Antes de preparar el bloque se comprobó que el último pedido entregado ocurrió el
8 de agosto de 2026 a las 8:24 p. m. (America/Caracas). No hubo entregas después
del inventario de cierre, por lo que el conteo certificado continúa siendo una
base válida para la apertura de la mañana siguiente.

## Estado al entregar el código

Este bloque instala el flujo, pero no suplanta las sesiones operativas ni pulsa
los botones por los usuarios. Hasta que Administración presente y Master acepte:

- 0 de 48 aperturas permanecen aceptadas;
- 0 de 13 recetas permanecen activas;
- Supabase continúa en modo `legacy`;
- las órdenes siguen sin bloqueo de inventario.

