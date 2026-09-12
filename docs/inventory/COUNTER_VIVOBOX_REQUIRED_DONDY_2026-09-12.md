# Counter: Dondy obligatorio de las Vivo Box

## Causa y regla

Las Vivo Box de 6, 8 y 10 UND conservan en `product_components` un Dondy
obligatorio (`GAMBIT_DONDY_1`) adicional al total seleccionable y a la salsa.
Su ficha está inactiva para venta individual. `counter_read_catalog` la omitía
por ese estado, por lo que el carrito quedaba sin Dondy. El escritor
`counter_direct_sale_item_notes` también rechazaba componentes inactivos y
exigía los obligatorios, haciendo inconsistente el armado con la validación.

Un componente fijo obligatorio de un combo activo debe conservarse en su
composición aunque no esté activo como producto independiente. Se corrigen las
dos funciones existentes, sin crear tablas, columnas ni activar la ficha.
Las opciones seleccionables y opcionales mantienen sus condiciones anteriores.
Las suspensiones comerciales y las jugadas CRM no cambian.

## Verificación

- Migración aplicada: `20260912233928_counter_preserve_required_combo_components.sql`.
- `tests/counter/required-combo-components.sql`: tres cajas incluyen un Dondy en
  lectura y detalle generado; rechaza omisión, cantidad incorrecta y venta
  individual de la ficha inactiva. El acceso sin autenticación sigue denegado.
- Navegador de producción: nueva venta, Vivo Box XXL, 6 minis + 2 empanadas +
  2 cachitas. El carrito muestra además `1 Salsa Tártara 2oz` y `1 Dondy (1 und)`.
  La orden de prueba no se creó ni se envió a cocina.
- Revisión de permisos: se conservan firmas, permisos y controles de rol.
  El asesor de Supabase señala la exposición autenticada de la función de
  lectura SECURITY DEFINER; es intencional y conserva la comprobación interna
  de Counter/Máster/Admin y `search_path` vacío.
- No hubo cambios de aplicación que requieran recompilar ni cambios históricos
  de órdenes, movimientos o saldos.

## Operación

Recargar Counter y volver a agregar la caja al carrito. Un ítem armado antes
de recargar conserva su detalle anterior y debe quitarse y armarse de nuevo.
