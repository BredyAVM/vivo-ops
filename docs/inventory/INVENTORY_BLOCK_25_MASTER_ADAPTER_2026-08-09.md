# Bloque 25 — Adaptador operativo de inventario para Máster

Fecha: 2026-08-09

## Resultado

Máster dispone de una ruta propia y liviana en
`/app/master/ops/inventory`. La dashboard operativa no consulta inventario al
cargar: el botón `Inventario` conserva `prefetch={false}` y abre esta ruta bajo
demanda.

La vista permite:

- consultar el saldo canónico de los 48 ítems inicializados;
- distinguir existencias bajo su umbral configurado;
- solicitar a Cocina un conteo ciego de uno o varios ítems;
- ver solicitudes abiertas y su fecha límite;
- abrir los reportes presentados para aceptarlos o pedir reconteos específicos;
- consultar la actividad reciente y enlazar el historial completo.

## Reutilización del modelo existente

No se creó ninguna tabla. Se reutilizan:

- `inventory_items` para el saldo canónico;
- `inventory_counts` para encabezados de conteo;
- `inventory_count_lines` para ítems, foto esperada y diferencias;
- `inventory_review_count_v1` para aceptar o pedir reconteos;
- el adaptador de Cocina del bloque 24 para responder solicitudes.

La única columna nueva es `inventory_counts.request_operation_id`, necesaria
para impedir duplicados cuando una acción se reintenta. Tiene un índice único
parcial y solo se usa al abrir solicitudes de Máster.

## Comando nuevo

`inventory_request_count_v1`:

- exige usuario autenticado con rol `master` o `admin`;
- acepta de 1 a 200 ítems activos, inventariables e inicializados;
- rechaza ítems repetidos o que ya tengan un conteo pendiente;
- toma una foto de `current_stock_units` en las líneas;
- asigna el conteo ciego a Cocina;
- usa 30 minutos como fecha límite cuando Máster no indica una;
- reproduce el mismo resultado ante el mismo UUID de operación;
- no crea movimientos, no modifica existencias y no toca órdenes.

El RPC es `SECURITY DEFINER` de forma intencional porque Máster no tiene permiso
de escritura directa sobre las tablas. Su cuerpo vuelve a validar el rol con
`auth.uid()`, fija `search_path = ''`, y `anon`/`public` no tienen `EXECUTE`.

## Verificación

- Prueba transaccional reversible ejecutada en Supabase: aprobada.
- Reintento idempotente: aprobado; devuelve el mismo conteo.
- Intento con rol Cocina: rechazado.
- Saldos, movimientos y órdenes antes/después: sin cambios.
- Rollback: cero solicitudes residuales.
- ACL: `authenticated` y `service_role`; `anon` y `public` sin ejecución.
- Advisor de seguridad: solo advierte que el RPC autenticado es
  `SECURITY DEFINER`; es una exposición deliberada y protegida por la validación
  interna descrita arriba.
- Advisor de rendimiento: sin avisos sobre los objetos del bloque.
- ESLint de los archivos tocados: aprobado.
- `npm run build`: aprobado.
- El lint global conserva errores preexistentes fuera del bloque.

La prueba reproducible queda en
`docs/inventory/INVENTORY_BLOCK_25_TRANSACTION_TESTS_2026-08-09.sql`.
