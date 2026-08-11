# Bloque 32 — piloto administrativo de conteos y ajustes

Fecha: 2026-08-10

## Resultado

Administración dispone de `Inventario > Ajustes y pruebas`, una sección cargada
solo al abrirla y separada de las operaciones diarias de Cocina.

La pantalla ofrece dos operaciones:

### Conteo físico

Se usa cuando alguien verificó físicamente una cantidad. Registra un conteo
`requested`, crea su reporte para revisión de Máster y alinea inmediatamente el
saldo con lo contado.

### Ajuste administrativo

Se usa para corregir un dato conocido sin presentarlo como conteo. Define una
existencia objetivo, exige un motivo y registra un movimiento
`manual_adjustment` con nota opcional.

## Permisos

- Administración puede abrir y ejecutar las dos operaciones.
- Máster puede ver el saldo y revisar conteos, pero no puede abrir ajustes.
- Asesor, Counter y Cocina no reciben acceso a esta herramienta.

Los RPC existentes mantienen autorización interna por rol, `search_path` fijo y
sin permiso de ejecución para `anon`.

## Centro de verdad

No se crearon tablas, columnas, saldos alternos ni migraciones. Se reutilizan:

- `inventory_adjust_stock_v1`;
- `inventory_submit_count_v1`;
- `inventory_movements`;
- `inventory_counts` e `inventory_count_lines`;
- `inventory_reporting_workspace_v1`.

La misma pantalla muestra los últimos conteos y ajustes para que las pruebas no
queden sin trazabilidad.

## Garantía no bloqueante

Estas operaciones corrigen el saldo y refrescan reportes/alertas, pero no cambian
el flujo de órdenes. Los negativos producidos por ventas siguen visibles hasta
que un conteo o ajuste confirme la realidad física.

## Verificación

Prueba transaccional reversible:

1. ajuste administrativo de `+1` sobre un ítem real;
2. confirmación del saldo ajustado;
3. conteo puntual que devuelve el ítem a su cantidad original;
4. creación del reporte `submitted` y movimiento `stock_count`;
5. `rollback` con saldo original restaurado.

`npm run build`: correcto.
