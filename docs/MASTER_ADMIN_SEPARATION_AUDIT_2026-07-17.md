# Auditoria de separacion Master Operativo / Administracion

Fecha: 2026-07-17
Ruta actual revisada: `src/app/app/master/dashboard`

## Objetivo

Separar la pantalla actual, que mezcla operacion diaria del master con administracion, finanzas, catalogo, inventario, usuarios y calculos, sin interrumpir la operacion en produccion.

La nueva pantalla del master debe construirse aparte, probarse en paralelo y activarse solo cuando este validada por operacion.

## Hallazgo principal

La ruta actual `/app/master/dashboard` ya esta configurada como dinamica y sin revalidacion de pagina (`dynamic = 'force-dynamic'`, `revalidate = 0`), pero carga demasiados dominios antes de renderizar:

- Usuarios y roles administrativos.
- Estados de inbox y notificaciones.
- Partners, drivers y asesores.
- Periodos/cierres de comisiones.
- Ordenes del dia, semana, busqueda y bandeja.
- Estados financieros por orden.
- Items, pagos, movimientos y ajustes por orden.
- Cuentas, reglas, cierres, lineas base, conciliaciones y snapshots de saldo.
- Catalogo, componentes, inventario, recetas y vinculos de inventario.
- Clientes y herramientas de CRM/configuracion.

El problema no es solamente cache. El problema central es que el master operativo esta compartiendo la misma pantalla y la misma carga inicial con administracion.

## Corazon operativo del master

Esto si debe formar parte de la nueva ruta `Master Operativo`.

### Datos iniciales

- Usuario actual y roles.
- Fecha operativa seleccionada.
- Tasa activa.
- Ordenes del dia seleccionado.
- Ordenes relevantes por acciones pendientes, aunque no sean del dia.
- Resumen semanal minimo para operacion.
- Asesores activos.
- Drivers internos.
- Partners externos activos.
- Catalogo minimo necesario para leer/modificar una orden.
- Componentes de productos necesarios para mostrar/editar pedidos correctamente.
- Estados financieros de las ordenes visibles.
- Items, reportes de pago, movimientos y ajustes solo de las ordenes visibles.
- Notificaciones/inbox operativo.

### Acciones del master que deben quedar

- Aprobar orden creada.
- Reaprobar orden modificada.
- Devolver orden al asesor.
- Modificar orden cuando aplique por permisos.
- Proteger precio solo si el usuario es admin.
- Enviar a cocina.
- Tomar en cocina / asignar ETA si el master lo necesita por contingencia.
- Marcar preparada si el master lo necesita por contingencia.
- Marcar lista/retiro/en camino/entregada segun el flujo actual.
- Asignar delivery interno.
- Asignar delivery externo.
- Corregir delivery entregado solo admin.
- Quitar asignacion cuando aplique.
- Reportar pago si el master lo carga.
- Confirmar pago.
- Rechazar pago.
- Reportar retencion.
- Aplicar fondo del cliente.
- Devolver fondo al cliente.
- Cerrar diferencias minimas por redondeo segun regla.
- Ver timeline/eventos de la orden.
- Copiar WhatsApp.
- Buscar ordenes por numero, cliente o telefono.
- Ver acciones y seguimiento separados.
- Editar tasa activa.

### Vista sugerida

La primera pantalla debe ser solamente operacion:

- Header compacto: fecha, tasa, acciones, seguimiento, usuario.
- Filtros operativos de ordenes.
- Busqueda de orden/cliente.
- Tabla/lista de ordenes.
- Panel de detalle de orden.
- Drawers de acciones puntuales.

No debe cargar ni mostrar cuentas, usuarios, catalogo completo, inventario, comisiones ni conciliaciones en la entrada.

## Administracion

Esto debe salir del master operativo y quedarse en la consola de administracion.

Por ahora puede seguir viviendo en `/app/master/dashboard`, porque ya esta en produccion y el administrador la usa. A futuro se puede mover o duplicar hacia `/app/admin/dashboard`.

### Areas administrativas

- Cuentas financieras.
- Movimientos financieros generales.
- Cierres, arqueos y conciliaciones.
- Lineas base.
- Configuracion de reglas de cuentas.
- Catalogo y duplicacion/creacion de productos.
- Cambios masivos de precios.
- Inventario, recetas y produccion.
- Usuarios y roles.
- Clientes y CRM.
- Comisiones de asesores.
- Ajustes administrativos.
- Partners y tarifas de delivery.
- Auditoria financiera.

## Caja del master

El master si puede necesitar registrar ingresos/egresos de caja chica o revisar si hay efectivo, pero eso no debe cargar dentro de la pantalla operativa principal.

Recomendacion:

- Crear una ruta o modulo separado: `/app/master/cash`.
- Carga bajo demanda.
- Solo cuentas necesarias para operacion del master.
- Registrar ingreso/egreso.
- Enviar egreso a aprobacion admin cuando aplique.
- Mostrar saldo operativo de caja chica.
- No mostrar conciliaciones, reglas contables ni estado de cuenta completo.

## Ruta propuesta

### Fase 1 - Prototipo paralelo

Crear `/app/master/ops` como ruta nueva, sin redirigir a nadie todavia.

Debe reutilizar la logica actual, pero cargar solo:

- user/roles/profile
- tasa activa
- ordenes operativas
- inbox/notificaciones
- asesores
- drivers/partners
- catalogo minimo para mostrar/editar pedidos
- estados financieros de ordenes visibles
- items/pagos/movimientos/ajustes de ordenes visibles

La ruta actual queda intacta.

### Fase 2 - UI operativa

Extraer o recrear con la misma semantica:

- Header operativo.
- Tabla/lista de ordenes.
- Panel de detalle.
- Acciones/seguimiento.
- Buscador.
- Drawers de aprobacion, devolucion, pago, delivery y cocina.

No se debe cambiar la logica de negocio en esta fase.

### Fase 3 - Caja separada

Crear `/app/master/cash` o boton lateral desde `Master Operativo`.

Debe cargar solo cuando se abra.

### Fase 4 - Admin

Mantener `/app/master/dashboard` como consola pesada mientras se valida.

Luego:

- Crear `/app/admin/dashboard`.
- Mover alli cuentas, catalogo, inventario, usuarios, comisiones y auditoria.
- Dejar `/app/master/dashboard` redirigiendo a `/app/master/ops` solo cuando el usuario apruebe el cambio.

## Reglas para no romper produccion

- No reemplazar la ruta actual de golpe.
- No quitar botones actuales hasta que la ruta nueva este validada.
- No crear una semantica nueva para ordenes.
- Reutilizar `order-domain`, `order-money`, `payment-report-rules`, `order-snapshots` y helpers existentes.
- No duplicar reglas de pagos o estados.
- No cargar datos administrativos en `Master Operativo`.
- No hacer que una pantalla operativa dependa de cuentas/conciliaciones para renderizar.
- Mantener la busqueda amplia por orden, cliente y telefono.
- Mantener acciones y seguimiento como canales separados.

## Decision recomendada

Construir `Master Operativo` en paralelo, usando la pantalla actual como fuente de verdad funcional, pero recortando la carga inicial y separando la administracion.

La ruta actual debe quedar como respaldo y consola admin mientras se prueba la nueva. Cuando la nueva pantalla este validada en operacion real, se hace el cambio de entrada por rol.
