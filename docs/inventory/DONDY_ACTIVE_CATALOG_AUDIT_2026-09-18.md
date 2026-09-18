# Auditoría: Dondys activos que no pueden cargarse en órdenes

Fecha: 2026-09-18. Alcance: diagnóstico, sin modificar código operativo, catálogo, órdenes ni esquema de producción.

## Resultado

Existen dos restricciones coherentes entre sí, pero incompatibles con la regla de negocio solicitada: el tipo `gambit` se trata como exclusivo de una jugada CRM salvo una excepción explícita `advisor_gift`. Estar activo no elimina esa restricción.

1. Asesor oculta esos productos en su catálogo ordinario.
2. Máster sí permite seleccionarlos, pero la base de datos rechaza guardarlos en una orden cuyo origen es `advisor`, aunque quien esté editando sea Máster.
3. El error de negocio se lanza como excepción desde una acción del servidor y llega a la interfaz como el mensaje genérico de producción mostrado en la captura.

El inventario no causa este rechazo. No se debe corregir cambiando la familia física del Dondy, duplicando productos ni eliminando su descuento de crudos.

## Caso examinado

- Captura: editor de Máster, orden interna 2689, origen Asesor, Combo Rumba Mix Frito y un Dondy (1 und) de precio cero agregado.
- Orden persistida: `VO-20260917-2062`, estado `queued`. Al consultar durante la auditoría contenía únicamente la línea original del combo, producto 67. El Dondy del intento fallido no quedó guardado.
- Producto de la captura: 89, SKU `GAMBIT_DONDY_1`, nombre `Dondy (1 und)`, activo, tipo `gambit`, sin `catalog_access_scope` explícito.
- Producto 89 reactivado el 18 de septiembre a las 12:22:58 UTC. Su configuración de inventario está lista: consumo directo de 1 UND del ítem 47, `Dondys Crudos`.
- Precio de catálogo cero; costo para el asesor de USD 0,50. No confundir con el Dondy pagado ni con el obsequio Cliente Nuevo.

## Variantes vigentes

| Producto | ID | Ámbito configurado | Resultado de las reglas examinadas |
| --- | ---: | --- | --- |
| Dondy (1 und), obsequio genérico | 89 | Sin ámbito explícito | Oculto al asesor; rechazo si se agrega normalmente a una orden de origen Asesor |
| Dondy (1 und) Cliente Nuevo | 156 | `advisor_gift` | Excepción habilitada para obsequio discrecional |
| Dondys (3 und) Cliente Nuevo | 93 | `advisor_gift` | Excepción habilitada para obsequio discrecional |
| Dondy (1 und) Cumpleaños | 161 | `crm_only` | Reservado por las reglas actuales a una jugada CRM |
| Dondys (3 und) Cumpleaños | 138 | `crm_only` | Reservado por las reglas actuales a una jugada CRM |
| Dondy (und), pagado | 133 | Producto ordinario | No afectado por esta restricción de tipo |
| Dondys, servicio | 4 | Producto ordinario | No afectado por esta restricción de tipo |

Los vínculos de inventario examinados apuntan al mismo crudo, con las cantidades correspondientes. Las variantes históricas inactivas no deben reactivarse como solución. No se encontraron referencias de beneficios o mejoras CRM para los Dondys 89, 93, 138, 156 y 161 en las consultas realizadas; por tanto, la exigencia de una jugada no constituye por sí misma una vía disponible para cargar el 89.

## Trazabilidad del bloqueo

### Catálogo del asesor

`src/lib/crm/play-order.ts:41`, función `isCrmOnlyCatalogProduct`, considera exclusivo de CRM:

```ts
scope === 'crm_only' || (product.type === 'gambit' && scope !== 'advisor_gift')
```

`src/app/app/advisor/new/AdvisorOrderComposer.tsx:1837` excluye esos productos, adicionalmente a los filtros de activo, componente interno y catálogo administrativo. Así, el producto 89 no aparece aunque esté activo.

### Selección en Máster y guardado

El catálogo de `src/app/app/master/ops/actions.ts` consulta productos activos y excluye `admin_internal`, pero no aplica la exclusión general de gambits del asesor. Esto permite seleccionar el 89.

El recorrido de guardado es:

`MasterOpsOrderEditor` → `updateMasterOpsOrderAction` → preparación/validación → `updateOrderAction` de Dashboard → RPC `update_order_core_atomic_v1` → escritura de `order_items` → trigger `crm_order_items_guard`.

El trigger ejecuta `app_private.crm_order_item_guard_v1()` antes de insertar o actualizar. La definición consultada en producción distingue:

- Línea con identificadores CRM: valida la jugada, cliente, asesor, beneficio, cantidades, vigencia y condiciones.
- Línea sin identificadores CRM con ámbito `advisor_gift`: aplica la excepción autorizada y sus controles de precio cero y rol.
- Otra línea sin identificadores CRM: si la orden es de origen `advisor` y el producto es `gambit` o `crm_only`, la rechaza.

Mensaje explícito de esa rama, código SQL `42501`:

> Este beneficio solo puede cargarse desde una jugada activa del cliente.

La condición usa el origen de la orden, no solamente el rol del operador. Por eso editar como Máster una orden del asesor no evita el rechazo. Esta misma rama no impone el rechazo a una orden `walk_in`; eso revela una diferencia entre canales, sin demostrar que todas las demás validaciones de Counter permitan cualquier variante.

### Por qué aparece el mensaje genérico

`src/app/app/master/dashboard/actions.ts:9719` ejecuta la RPC. En la línea 9733, los errores distintos del conflicto de edición se convierten en `throw new Error(atomicSaveError.message)`. La excepción atraviesa la acción del servidor y la interfaz muestra su mensaje. En producción, el detalle de una excepción no controlada se oculta: el usuario no recibe el motivo comercial anterior.

La captura por sí sola no identifica una causa: la atribución se apoya en el producto, el origen de la orden y la definición vigente del trigger. No se recuperó el registro individual de esa petición de Vercel.

## Origen histórico y alcance

- `20260911205304_crm_catalog_benefit_boundary.sql`: estableció el límite de beneficios CRM y marcó los gambits entonces activos como `crm_only`. La migración consta en producción con versión `20260911210834`. El 89 no tiene esa marca, pero queda cubierto por la condición general de tipo.
- `20260914135042_advisor_discretionary_new_client_gifts.sql`: habilitó únicamente los SKU `GAMBIT_DONDY_1_CN` y `GAMBIT_DONDYS_3` como `advisor_gift`. No habilitó el Dondy genérico 89 ni los cumpleaños.
- `20260914164904_preserve_unchanged_legacy_gifts_on_order_edit.sql`: preserva líneas históricas sin cambios bajo condiciones estrictas. No permite agregar una nueva línea de obsequio como en este caso.
- La corrección de componentes obligatorios de Vivo Box en Counter es otra ruta. No resuelve el alta de un Dondy independiente en una orden de asesor.

Se identificaron 14 productos activos sujetos al filtro restrictivo: 89, 138, 161, 164, 126, 160, 144, 125, 136, 158, 142, 157, 159 y 143. Incluyen Dondys, degustación prefrita y Single Packs promocionales. No se intentó guardar órdenes con cada uno: el alcance surge de evaluar las mismas condiciones sobre sus datos vigentes.

## Verificaciones realizadas

- Consulta de productos, vínculos de inventario, referencias CRM y contenido persistido de la orden 2689.
- Inspección de funciones y triggers vigentes en Supabase, y contraste con migraciones y rutas de guardado del repositorio.
- Consulta de disponibilidad del producto 89 para el 18 de septiembre a las 17:00 Caracas, superficie `advisor_availability`. Alrededor de las 12:39 UTC devolvió `available`, 245 UND disponibles sin afectar compromisos, requerimiento 1 UND, sin suspensión, sin bloqueo de protección y `inventory_blocks_submission = false`. Es una lectura puntual, no un saldo permanente.
- La consulta de disponibilidad se ejecutó con contexto de autorización local a una transacción revertida. No se guardaron órdenes de prueba ni se cambiaron existencias.
- Las seis pruebas existentes de `tests/crm/play-order.test.mts` pasaron. Algunas exigen expresamente ocultar gambits sin excepción: prueban la implementación actual, no la política solicitada por el usuario.
- El acceso a registros de ejecución de Vercel devolvió 403. No fue posible obtener el error/digest individual del intento mostrado. No se reprodujo mediante una modificación de la orden real.

## Corrección recomendada, aún no implementada

1. Unificar la elegibilidad del catálogo comercial en Asesor, Máster y Counter: el tipo de producto, por sí solo, no debe exigir una jugada. Aplicar la regla acordada de productos comerciales activos sin convertir componentes internos en productos vendibles. Mantener permisos explícitos, vigencias y suspensiones deliberadas del Máster.
2. Separar el producto de su utilización dentro de una jugada: si la línea realmente trae vínculo CRM, conservar las validaciones completas de campaña y beneficio; una línea ordinaria no debe adquirir obligatoriamente esa naturaleza solo por ser `gambit`. Revisar los ámbitos históricos `crm_only` junto con esta política, no limitar el arreglo a cambiar un único Dondy a `advisor_gift`.
3. Preservar precios y costos para el asesor, comisiones, cantidades e inventario. Habilitar un obsequio no significa eliminar su costo interno, cambiar su receta ni reutilizar el producto pagado. Reutilizar las tablas y campos existentes; no hay necesidad demostrada de crear otros.
4. Devolver errores comerciales como resultados estructurados y mensajes comprensibles. Reservar los detalles internos para registros del servidor; la interfaz no debe recibir el texto genérico de Next.js ante un rechazo esperado.
5. Actualizar pruebas para el contrato solicitado: producto activo ordinario o gambit, creación/edición por asesor, Máster editando origen Asesor, Counter, variantes Cliente Nuevo/cumpleaños, precios cero, costos y consumo correcto. Conservar pruebas negativas de jugadas vinculadas inválidas, productos inactivos, permisos, suspensiones y duplicación de beneficios; comprobar que Vivo Box mantiene sus componentes.

No se aplicó esta corrección, no se modificó la orden 2689 y no se hizo commit ni despliegue. La auditoría precede a cualquier cambio funcional, como pidió el usuario.
