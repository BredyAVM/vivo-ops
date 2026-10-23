# Transporte propio sin pago por viaje

## Regla operativa

Máster/Admin asigna por nombre a quien lleva un pedido con recursos propios o
personal pagado por horas. No requiere crear usuario, rol Driver ni empresa.
El pago por ese viaje es cero explícito, no costo desconocido. No representa
costo laboral total cero ni modifica el delivery cobrado al cliente.

En Máster Ops: orden → Entrega → Transporte propio → nombre obligatorio,
teléfono/nota interna opcionales → Guardar. Después se usan salida y entrega
habituales. Aplica a delivery sin asignación en `confirmed`, `in_kitchen` o
`ready`. Para cambiar un responsable existente, se quita primero su asignación.
No reabre órdenes entregadas/canceladas ni modifica una custodia existente.

## Persistencia y compatibilidad

- `assign_own_transport_v1`: invocador, sesión Máster/Admin, bloqueo de orden,
  fecha, actor y clave de operación. Repetir la solicitud devuelve el comprobante;
  reutilizar su clave con otros datos se rechaza. Evento y asignación son atómicos.
- Reutiliza transportista nominal: `delivery_mode = external`,
  `external_driver_name` / `external_driver_phone`, sin `internal_driver_user_id`
  ni `external_partner_id`. Ese modo técnico conserva compatibilidad con despacho
  y custodia; no representa un proveedor externo remunerado.
- Subtipo `extra_fields.delivery.own_transport`, versión 1; `cost_usd = 0`
  numérico y `cost_source = own_transport_v1`. `is_own_transport_v1(orders)`
  comprueba juntos modalidad, nombre, ausencia de IDs, costo y fuente. Un nombre
  suelto o un delivery ordinario de costo cero no equivalen a transporte propio.
- No añade tablas, columnas, enums, usuarios, empresas ni cuentas.
- El guard impide inyectar el subtipo en pedidos nuevos o modificarlo desde
  Asesor/Driver/Counter. Counter despacha sin modificar la identidad.
- Quitar/reasignar antes de salir limpia el subtipo y snapshot anteriores.
  Convertir a pickup también lo elimina; el guard no cambia importes. Admin
  conserva su corrección histórica autorizada y evidencia de la asignación previa.
- La opción vive en el espacio compartido de órdenes Máster Ops/Admin. Máster
  y Counter muestran «Transporte propio». No se editan archivos de Dashboard.

## Tres ejes separados

1. Venta: no toca partidas, precios, descuento, impuesto, versión comercial,
   tasa, total, reportes, fondo ni pagos del cliente.
2. Pago por viaje: snapshot cero; no genera egreso, deuda ni recibo de proveedor.
   `admin_delivery_services_v1` excluye únicamente el subtipo propio válido,
   conservando otros deliveries de costo cero y el historial físico en la orden.
3. Cobro/custodia: si el responsable recibe efectivo del cliente, se mantienen
   `delivery_settlements` y sus entradas normales. Guarda su nombre/teléfono sin
   inventar un usuario/partner. Entregar físicamente no liquida ni perdona dinero.
   Cambio, retornos y saldo de la orden conservan sus comandos canónicos.

La salida `out_for_delivery` mantiene el corte físico de inventario existente;
`delivered` no debe duplicar consumo. No modifica escritores de inventario,
cálculos financieros ni historia anterior.

## Verificación

- `npm run test:own-transport`: 14 comprobaciones; PostgreSQL aislado con rutinas
  instaladas capturadas de solo lectura. Asignación, salida Máster/Counter,
  entrega, cobro bajo custodia, cero sin egreso, permisos, reintentos, pickup,
  corrección Admin y rollback si falla la auditoría.
- Regresiones: `test:orders-workspace` (32), `test:delivery` (42),
  `test:master-new-order-alerts` (19). Compilación de producción correcta.
- Los adaptadores locales de custodia/comandos no certifican una transferencia
  real ni una carrera entre conexiones independientes. No se crean órdenes de
  prueba ni se asigna/despacha un pedido real para verificar esta entrega.
- Supabase/Postgres orientan permisos, bloqueos y preservación de ledgers.
  La revisión React mantiene formulario bajo demanda y bloqueo al guardar,
  sin polling ni consultas nuevas en la entrada.

Migración aplicada: `20261023152019_own_transport_without_trip_pay.sql`.
Verificación posterior: permisos sin acceso anónimo y 131 rutinas de inventario,
estado financiero y despacho/custodia Counter idénticas a las previas.
Los asesores de Supabase conservaron sus hallazgos previos, sin nuevos avisos de
seguridad ni rendimiento por esta migración.
