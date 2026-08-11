# Bloque 30 — disponibilidad por fecha para Asesor

Fecha: 2026-08-10

## Resultado

El creador de pedidos del Asesor ahora sigue este orden:

1. cliente;
2. fecha y hora;
3. productos;
4. entrega.

La búsqueda de productos se habilita después de definir la fecha y la hora. En
ese momento consulta el contrato canónico existente
`inventory_catalog_availability_v1` para la superficie
`advisor_availability`.

## Señales visibles

Cada producto puede mostrar:

- disponible sin afectar pedidos confirmados;
- quedan pocos;
- depende de reposición o producción esperada;
- sin disponibilidad protegida;
- fuera del horizonte operativo de 10 días;
- depende de la selección del combo;
- requiere revisión de Máster;
- no inventariable.

Las advertencias se conservan también en los renglones agregados al pedido para
que el Asesor conozca cuáles necesitarán decisión de Máster.

## Regla no bloqueante

La disponibilidad no participa en `createReady`, no deshabilita el envío y no
impide agregar productos. Si la consulta falla, la pantalla informa que se puede
continuar y que Máster revisará la solicitud.

El Asesor agenda y envía; Máster mantiene la decisión final.

## Reutilización

No se crearon tablas, columnas, RPC ni migraciones. Este bloque conecta al flujo
del Asesor la arquitectura de disponibilidad por fecha que ya existía.

## Verificación

- Catálogo con fecha dentro del horizonte: lectura con productos y contrato
  `inventory_blocks_submission = false`.
- Fecha a 30 días: productos marcados `outside_horizon`, también no bloqueantes.
- `npm run build`: correcto.
