# Cocina: contrato de cantidades y auditoría

Fecha: 2026-09-15. Alcance: lectura y presentación de Cocina. No se modificaron órdenes, catálogo, inventario, permisos ni otros módulos.

## Evidencia de producción (solo lectura)

- Orden 2621, línea 12035: 3 Combo Sexy Mix Frito. Sin filas en `order_item_components`; notas `@sel` con totales 30/30/30/30/30 y 3 salsas. El motor de inventario resolvió esos mismos totales y registró seis salidas correctas al despachar. Cocina multiplicaba otra vez por 3.
- Orden 1828, línea 8909: 2 Single Pack. Notas antiguas 5/5 y 1 salsa por presentación, pero `order_item_components` contiene los totales 10/10 y 2 salsas. No es necesario inferir ni multiplicar las notas.
- Orden 2606, línea 11958: obsequio Single Pack de 6 piezas; composición guardada 6 empanadas y 1 salsa. Se conserva su identificación de jugada.
- La lectura real usando la proyección y adaptación de `kitchen/page.tsx` confirmó 20, 150 y 6 piezas respectivamente, sin advertencias para esas tres líneas.

## Regla de lectura

La prioridad coincide con `app_private.inventory_order_sale_diagnostics_v1`, inspeccionada en producción:

1. Totales guardados en `order_item_components`, cuando existen.
2. Totales de selección `@sel` si no hay composición guardada.
3. Solo para componentes fijos obligatorios ausentes: receta por cantidad de presentaciones.

`@sel` no identifica por sí solo cantidades por presentación. Los nombres Single Pack, Combo y los textos de jugadas no deciden multiplicadores. `counts_toward_detail_limit` valida selecciones editables; no clasifica las piezas de combos fijos (la configuración de la 2621 tiene ese indicador apagado).

## Salvaguardas de Cocina

- Resultado calculado una sola vez en el servidor, compartido por tarjeta, contador e impresión; no se serializa el catálogo completo al teléfono.
- No se agrupan filas distintas de una orden. Se conservan selecciones y notas «Para:» de cada una.
- La indicación «iguales» y el detalle por presentación solo se muestran para composición fija confirmada o cuando los totales guardados corroboran íntegramente las notas antiguas por presentación.
- Totales conjuntos de packs configurables no prueban reparto idéntico, aunque sus cantidades sean divisibles. Se solicita confirmar el armado cuando ese reparto no está registrado.
- Discrepancias entre notas y composición, cantidades fuera del contrato, componentes desconocidos o anidados y datos insuficientes muestran revisión. El contador no presenta un total como confirmado y el ticket conserva la advertencia.
- Notas numéricas como «2 bolsas separadas» no se suman como comida; metadatos internos no se imprimen. No se redondean las cantidades seleccionadas.
- Esta vista no repara datos, sincroniza composiciones ni ejecuta descuentos de inventario.

## Verificación

- `npm run test:kitchen`: 26 pruebas, incluyendo casos reales, combinaciones antiguas/actuales, edición del Máster, obsequios, cantidades fraccionarias, notas y renderizado del JSX real de pantalla/ticket con servicios externos simulados.
- `npm run test:order-details`: 29 pruebas existentes, sin cambios en otros módulos.
- ESLint de los cuatro archivos de código/pruebas modificados: sin errores.
- TypeScript completo: 13 errores preexistentes en pruebas de Administración/Comisiones; comparación contra HEAD en memoria: los mismos 13, cero nuevos. No se corrigieron por estar fuera de alcance.
- Verificación visual en el dispositivo físico y despliegue de producción no certificados por estas pruebas.

## Límite pendiente

El pedido actual puede guardar una selección agregada sin una distribución individual por pack. Para exigir ese reparto en el origen se necesitaría autorización sobre el módulo creador/editor y un contrato explícito. Cocina no inventa esa información ni modifica esos módulos.
