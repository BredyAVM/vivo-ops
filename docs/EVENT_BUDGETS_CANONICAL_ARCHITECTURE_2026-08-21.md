# Presupuestos administrativos de eventos — arquitectura canónica

Fecha: 2026-08-21

## Decisión principal

Un evento no es un producto comercial reutilizable del catálogo. Es una propuesta específica que solo Administración puede construir, cotizar y convertir en orden.

El registro histórico `PACK_EVENTO` se conserva activo únicamente como identificador técnico interno de la línea principal de la orden. Su `extra_fields.catalog_access_scope = admin_internal` lo excluye de los selectores normales de Administración, Máster y Asesor.

## Centro de verdad reutilizado

- `advisor_order_drafts`: propuesta, cliente, asesor asignado, precio, tasa y estado previo a la aceptación.
- `products` y `product_components`: productos/servicios permitidos y resolución recursiva de la composición.
- `orders` y `order_items`: orden real creada después de la aceptación.
- `order_item_components`: fotografía física de la composición aceptada.
- `order_admin_adjustments`: fotografía comercial del precio y comisión específicos, usando `adjustment_type = other` y `payload.kind = event_commercial_terms`.

No se creó una tabla paralela de eventos ni una tabla paralela de comisiones.

## Ciclo operativo

1. Administración crea un borrador o presupuesto y lo asigna a un asesor.
2. El asesor puede consultarlo y compartirlo, pero no editarlo, archivarlo ni convertirlo.
3. Mientras sea presupuesto no crea compromisos de inventario.
4. Administración lo convierte en orden cuando el cliente acepta.
5. La composición se congela con marcadores `@sel` y el modo de preparación con marcadores `@prep`.
6. Desde la orden aplican los compromisos, el horizonte de diez días y el consumo no bloqueante ya canónicos.

## Preparación

Cada componente congelado conserva uno de estos modos:

- `kitchen`: preparado en cocina;
- `on_site`: llevado para freír/preparar en el sitio;
- `not_applicable`: servicio o producto que no necesita preparación.

El trigger de proyección de esta información es deliberadamente no bloqueante: un fallo de inventario no puede impedir crear o modificar la orden durante la etapa actual.

## Precio, moneda y pago

El precio negociado conserva su naturaleza de origen:

- si nace en VES, se guarda el monto en VES, la tasa congelada del presupuesto y su equivalente USD;
- si nace en USD, se guarda el monto en USD y el equivalente VES calculado con esa tasa.

El pago real es un hecho posterior e independiente. Debe registrarse en la moneda efectivamente recibida y conservar el monto y la tasa propios de esa operación. Convertir un presupuesto no crea un pago ni cambia la moneda de origen del precio.

## Comisión

La propuesta permite:

- comisión general del asesor;
- porcentaje específico del evento;
- evento sin comisión.

Al convertir, los términos quedan congelados en `order_admin_adjustments`. El cierre de comisiones prioriza esa fotografía por ítem sobre la configuración comercial actual del producto técnico, evitando que una modificación futura cambie el histórico.

## Permisos

- Admin: crear, editar, archivar y convertir presupuestos.
- Asesor asignado: leer la propuesta y abrir la orden convertida.
- Máster: opera la orden después de la conversión; no construye el presupuesto.

Las reglas se aplican en interfaz, acciones del servidor y RLS. La RLS permite al asesor leer su propuesta administrativa, pero excluye esas filas de sus permisos de inserción, actualización y borrado.
