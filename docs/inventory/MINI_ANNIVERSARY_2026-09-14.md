# Mini tequeños: aniversario del 14 al 20 de septiembre de 2026

Creación solicitada por Administración y realizada con sus funciones canónicas
de borrador y activación, bajo el contexto autorizado de Bredy Velásquez.

- Producto 199: `MINI_TEQ_F_25_ANIV_20260914`.
- Nombre visible: **Mini Tequeños Fritos (25 UND) · Aniversario 14–20 septiembre**.
- Precio de origen: USD 11. El equivalente en bolívares depende de la tasa.
- Solo servicio completo, 25 UND; `allows_half_service=false`, confirmado por el usuario.
- Tipo `service`, temporal, activo, configuración `ready`.
- Comisión `default`, heredada del producto tradicional.
- Consumo principal: 25 UND del mismo inventario de mini crudo.
- Alternativa de Máster: 1 servicio del mismo inventario de mini prefrito.
- No se creó stock independiente ni se modificó el producto original.
- No se incorporó como nueva opción seleccionable de combos.

La vigencia comercial se refiere a entregas del 14 al 20 de septiembre, ambos
inclusive, hora de Caracas. El usuario indicó que Máster filtra el uso durante
esa semana. `is_temporary` no implementa por sí solo una ventana automática de
ventas. Las fechas están visibles en el nombre; Máster revisa fecha y servicios
completos. El catálogo permite captura genérica de cantidades y no se cambió ese
flujo aquí. Al finalizar la promoción corresponde desactivar este producto para
nuevas ventas, conservando el histórico y el producto tradicional.

Verificado en producción: precio USD 11, 25 UND, sin medio servicio en la ficha,
enlace activo correcto, ambas rutas, catálogo de Counter con ambas presentaciones.
El alta se verificó en la misma transacción: original intacto y ningún ítem físico
nuevo. La instrucción SQL auditable está en `CREATE_MINI_ANNIVERSARY_2026-09-14.sql`;
protege contra duplicación por SKU y no debe volver a ejecutarse sobre el alta existente.
