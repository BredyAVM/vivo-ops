# Orden 3586: registro tardio de adicionales

## Autorizacion y alcance

El usuario confirmo expresamente que 250 mini tequenos fritos adicionales por USD
150 ya se entregaron y solo faltaba registrarlos. Se corrigio la misma orden,
sin crear otra venta ni reproducir cocina o retiro. No se modifico codigo de la
aplicacion, catalogo, permisos, funciones ni esquema.

## Resultado confirmado en Supabase

- Orden 3586, estado `delivered`, cliente 2812; fecha original 2026-10-30.
- Linea original 15572: evento con 175 piezas, USD 121.50, sin modificaciones.
- Nueva linea 16079: producto 5, 10 servicios de 25 piezas = 250 piezas;
  precio autorizado USD 15 por servicio, total USD 150.
- Nombre snapshot: `Mini Tequeños Fritos adicionales`.
- Total de venta y saldo pendiente USD 271.50; cantidad total 425 piezas.
- Tasa snapshot conservada: 887.30; total Bs snapshot 240901.95.
- La politica existente `native_usd` se conserva. El saldo cobrable en Bs usa la
  tasa activa y puede ser distinto al equivalente snapshot.
- Comision existente `fixed_order:5`, sin cambios. No se recalcularon cierres.
- Cero reportes de pago; no se registro ningun cobro.
- Ajuste administrativo 969 y evento de historial 36277.

## Inventario y operacion

El conteo fisico aceptado 6814, movimiento 18268, es posterior a la entrega.
No se vuelve a descontar stock actual ni se atribuye una diferencia de conteo
a estos adicionales. El movimiento original 18107 por -175 unidades permanece
sin cambios; no se agregan movimientos ni flujos planificados. La auditoria
explicita la venta historica y el motivo de no generar consumo actual.

Se mantienen estado entregado, fecha, retiro y marcas de cocina originales.
El presupuesto aceptado y sus revisiones comerciales permanecen intactos.

## Verificacion

El runbook `tools/events/regularize-3586-historical-additions.sql` termina en
`ROLLBACK` por seguridad. Se ejecuto primero de forma reversible, comprobando
totales y ausencia de efectos secundarios. Luego se ejecuto la misma transaccion
con `COMMIT`, y se verifico en una lectura independiente. Un reintento posterior
no duplico lineas ni auditoria gracias a su clave de regularizacion.

La correccion ya esta aplicada en la base. Publicar este archivo no ejecuta SQL
ni requiere un despliegue de la aplicacion para visualizar los datos corregidos.
