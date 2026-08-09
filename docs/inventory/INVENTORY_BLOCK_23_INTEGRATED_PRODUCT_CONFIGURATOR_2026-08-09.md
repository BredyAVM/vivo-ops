# Bloque 23 — Configurador integral de productos

Fecha: 2026-08-09

## Resultado

El Centro de Inventario es ahora el único lugar visible para crear y modificar
la configuración integral de un producto: identidad, precio, condiciones
comerciales y reglas físicas de inventario.

No se crearon tablas ni columnas. Tampoco se cambió la fórmula de comisiones,
la preparación de órdenes, Counter, Cocina ni el motor financiero.

## Auditoría previa obligatoria

La revisión del repositorio y de Supabase confirmó:

- `products.source_price_amount` y `products.source_price_currency` ya son el
  precio fuente del catálogo. El trigger existente
  `sync_product_derived_prices` mantiene `base_price_usd` y `base_price_bs`.
- `products.commission_mode`, `commission_value` y `commission_notes` ya son
  consumidos por los cierres de comisiones.
- `products.extra_fields.advisor_gift_cost_usd` ya es leído como descuento de
  obsequios para el asesor.
- `products.internal_rider_pay_usd` ya es leído por la operación de delivery.
- `inventory_save_catalog_draft_v1(jsonb)` e
  `inventory_update_product_identity_v1(jsonb)` ya eran los comandos seguros
  del configurador.
- los únicos escritores comerciales heredados estaban en el dashboard de
  Máster.

Estado observado antes de modificar: 147 productos, 103 activos, 135 con
comisión general, 8 con comisión específica por producto y 4 con comisión
específica por orden.

## Contrato canónico resultante

### Alta o reutilización de un borrador

`public.inventory_save_catalog_draft_v1(jsonb)` conserva su nombre, firma y
permisos. Su implementación estructural existente fue movida a
`app_private.inventory_save_catalog_draft_core_v1(jsonb)`, sin acceso para
`authenticated` ni `service_role`.

El RPC público llama ese núcleo y guarda, dentro de la misma transacción:

- precio fuente y moneda;
- modalidad, porcentaje y nota de comisión;
- costo de obsequio para el asesor;
- pago interno de delivery;
- identidad, unidades, componentes, enlaces y política de inventario.

El producto continúa naciendo inactivo y sin afectar stock ni órdenes.

### Modificación de un producto activo

`public.inventory_update_product_identity_v1(jsonb)` fue ampliado en lugar de
crear otro RPC. Puede modificar identidad y condiciones comerciales, pero
rechaza o evita cualquier cambio sobre:

- componentes;
- enlaces físicos;
- recetas;
- política de inventario;
- existencias;
- snapshots históricos de las órdenes.

Cuando cambia el precio, se conserva la advertencia que ya existía para
presupuestos abiertos con saldo pendiente.

## Interfaz

En `/app/inventory/configure`:

- el configurador universal incluye una sección explícita de condiciones
  comerciales;
- la reutilización de un producto inactivo precarga también sus condiciones;
- el editor de productos activos permite cambiar precio, comisión, costo de
  obsequio y pago de delivery;
- la tarjeta de impacto deja claro que esos cambios no alteran el descuento
  físico del producto.

En el dashboard de Máster:

- `Actualizar precios` fue sustituido por un enlace al Centro de Inventario;
- `Precio y comisión` fue sustituido por `Editar en Inventario`;
- `updateCatalogItemAction` y `updateCatalogPricesQuickAction` rechazan nuevas
  escrituras heredadas antes de alcanzar su implementación anterior.

Máster conserva toda su lectura operativa del catálogo y sus consumidores de
precio, delivery y comisión.

## Seguridad

- Ambos RPC públicos usan `security definer` con `search_path = ''`.
- Ambos verifican `auth.uid()` y el rol `admin` dentro de la función.
- `anon` y `public` no tienen permiso de ejecución.
- El núcleo privado solo es ejecutable por su propietario `postgres`.

Esta exposición intencional a `authenticated` es segura por el control interno
de rol y mantiene el patrón que ya utiliza el Centro de Inventario.

## Verificación

- Migración aplicada en el proyecto `hbgxqrrybonavaigaetz`.
- Prueba transaccional de alta y edición ejecutada con `ROLLBACK`.
- No quedó el SKU temporal `BLOCK23-TX-ROLLBACK`.
- Catálogo posterior: 147 productos y 103 activos, sin cambios de distribución
  de comisiones.
- Núcleo privado: ACL `{postgres=X/postgres}`.
- RPC público: ACL para `postgres`, `authenticated` y `service_role`.
- `npm.cmd run build`: aprobado.
- ESLint enfocado en los cuatro archivos del Centro de Inventario: aprobado.
- La revisión global de los dos archivos heredados de Máster conserva errores
  de lint preexistentes; no se mezclaron correcciones ajenas a este bloque.

Prueba reproducible:
`docs/inventory/INVENTORY_BLOCK_23_TRANSACTION_TESTS_2026-08-09.sql`.
