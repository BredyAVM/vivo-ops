# Administración operativa: hoja de ruta vigente

## Decisión del usuario

Administración debe servir para consultar y para actuar. Además de ingresos,
egresos y caja chica, debe permitir revisar órdenes, modificar precios o ajustes
cuando el estado y los permisos lo permitan, ratificar órdenes modificadas y
autorizar egresos. No agregar aprobaciones a operaciones que hoy no las necesitan.
Escritorio prioritario, móvil útil y poco texto. Publicar cortes verificados.

Este documento actualiza el orden de trabajo, no certifica que todos los bloques
estén implementados. Los documentos anteriores conservan evidencia histórica.

## Ampliación confirmada: cobertura administrativa completa

El usuario ratificó que el nuevo módulo debe permitir operar TODAS las capacidades
administrativas existentes, incluyendo crear productos, mantener catálogo y
usuarios, configurar comisiones y conectar los apartados de comisiones y jugadas.
No basta con un resumen de datos o un listado de enlaces sin recorrido operativo.

La cobertura se verificará por acción, no por existencia de una pantalla:

| Área | Operaciones que debe cubrir | Integración que debe comprobarse |
| --- | --- | --- |
| Catálogo | Crear y modificar productos; precios, componentes, presentaciones y activación | Producto utilizable al crear una orden; componentes válidos y descuento de inventario correcto; precios históricos conservados |
| Inventario | Configuración física, recetas, recepción, producción, conteos, ajustes, devoluciones y averías | Unidades, disponibilidad y órdenes consistentes; sin registrar dos veces una entrada o salida |
| Usuarios y permisos | Crear y administrar usuarios, estado y roles según la política autorizada | Permisos efectivos en cada módulo; cambios auditados, sin ampliar roles por el mero acceso a Administración |
| Órdenes y autorizaciones | Crear/editar, aprobar, ratificar, cambiar precios/ajustes permitidos, cancelar y rectificar según estado | Pagos, entrega, inventario, beneficios y comisiones conservan coherencia y trazabilidad |
| Comisiones y metas | Configurar reglas vigentes, periodos y metas; calcular, revisar, cerrar, reabrir cuando proceda, registrar deducciones y pagos autorizados | Reutilizar los apartados actuales, conservar orden/asesor/periodo y distinguir cálculo, cierre y pago |
| Jugadas y beneficios | Crear/configurar, probar, seleccionar participantes, activar y administrar ciclo de vida según permisos | Cliente/asesor/jugada/beneficio/orden vinculados; descuentos y regalos reflejados conforme a las reglas de comisión existentes, sin inventar nuevas reglas |
| Cuentas y caja | Ingreso, egreso, transferencia, aprobación, anulación, cierre y conciliación | Movimiento, cuenta, moneda, saldo e historial; sin doble contabilización |
| Clientes y cobranza | Crear/editar y consultar ficha, órdenes, fondos y seguimiento de pendientes | Acceso al caso original para resolver, sin repetir pagos ni perder relación con asesor/jugada |
| Delivery | Empresas, tarifas, asignación/corrección, costos pendientes, retornos y pagos de servicio | Separar precio al cliente, costo del servicio y dinero en custodia |
| Gobierno y reportes | Tasa, parámetros vigentes, notificaciones, eventos, descargas e historial | Acceso práctico con permisos actuales y filtros coherentes |

Esto es un listado de aceptación, no una certificación de que todas estas acciones
ya están disponibles en V2. Las capacidades nuevas o todavía incompletas, como
devoluciones y algunos pagos de servicio, mantienen sus bloques pendientes.

### Reglas de conexión y cierre de cada área

1. Inventariar cada opción administrativa vigente y clasificarla: operativa en V2,
   integrada a un centro existente, dependiente del panel anterior o pendiente.
2. Mantener un solo conjunto de reglas y registros por dominio. Integrar los
   centros ya construidos sin crear otra configuración de comisiones o jugadas.
3. Desde Administración debe poderse encontrar la acción, ejecutarla, comprobar
   su resultado y regresar al contexto de trabajo. Se permite un centro modular
   dedicado; no se exige meter todos los formularios en la portada de KPIs.
4. Probar recorridos conectados: producto → orden → inventario; jugada/beneficio →
   orden → comisión según reglas vigentes; comisión pagada → cuenta e historial.
5. Cambiar una configuración no debe reescribir silenciosamente ventas, beneficios
   aplicados o cierres históricos. Mostrar vigencia e impacto cuando corresponda.
6. No retirar el panel anterior hasta comprobar la cobertura de todas sus opciones.
   Si una capacidad se decide retirar o cambiar de alcance, requiere decisión explícita.

## Orden de implementación

1. **Cuentas operativas**: ingreso y egreso en Administración, cuenta preseleccionada,
   resultado e historial. Transferencias integradas con el comando atómico existente
   en el corte documentado en `ADMIN_TRANSFERS_UI_2026-09-12.md`; pendiente cierre
   de verificación visual y el endurecimiento adicional de ingresos/egresos.
2. **Autorizaciones y cierre**: primer corte de bandeja individual y decisión nativa
   de egresos en `ADMIN_AUTHORIZATIONS_2026-09-12.md`. Órdenes nuevas, ratificaciones
   y pagos conectados con su detalle operativo. Revisión nativa de versión exacta
   de órdenes implementada en `ADMIN_ORDER_REVIEW_2026-09-12.md`. Pendientes:
   antes/después completo de cambios comerciales, impacto en comisiones, cobertura
   de botones antiguos. Registro nativo de cierre implementado en
   `ADMIN_CLOSURE_UI_2026-09-12.md` para cajas y puntos. La conciliación diaria nativa
   queda en revisión por divergencia de corte horario/diario con el estado de cuenta.
   Requiere confirmar esa regla antes de habilitar bancos/wallets. Pendientes también
   anulación, resolución de diferencias y conciliación financiera completa.
3. **Cobranza y clientes**: saldo, pagos, diferencias, cambios y fondo del cliente,
   seguimiento y resolución desde cada caso sin repetir un cobro.
4. **Comisiones, metas, jugadas y delivery**: configuración y operación conectadas
   con los centros actuales; revisión, correcciones, cierre y pago; distinguir
   retorno de dinero en custodia del pago del servicio. Tratar faltantes e historia
   con evidencia, sin inventar costos ni pagos.
5. **Rectificaciones y devoluciones**: fechas/delivery/datos de órdenes con revisión
   del impacto; retorno físico por unidad y estado compatible, venta normal y avería
   o venta al asesor. La cancelación no demuestra por sí sola un retorno físico.
6. **Administración completa**: crear/editar productos y catálogo, inventario,
   clientes, usuarios y permisos, tasa, tarifas, eventos y notificaciones. Verificar
   cada opción vigente y su recorrido operativo; no limitar el bloque a enlaces.
7. **Pendientes, auditoría y reportes**: cobertura de todos los dominios, filtros y
   exportación coherentes, quién hizo/solicitó/autorizó y cuándo.
8. **KPIs y diseño común**: facturación y cierres día/semana, cobrado/pendiente,
   entregas y comparación temporal; escritorio/móvil. Rentabilidad y proyecciones
   requieren acordar fuentes y metodología de costos.

## Contrato transversal de autorización

- Una pantalla de consulta no equivale a un circuito terminado.
- Mostrar operación, solicitante, motivo, fecha, importe/moneda y cuenta u orden.
- Para cambios de precio/ajustes: valores antes/después e impacto comercial,
  cobro pendiente/saldo a favor y comisiones afectadas. No confundir el importe de
  una orden con el importe del cambio solicitado.
- Aprobar, rechazar o corregir según el tipo. Rechazo con motivo; al corregir,
  volver a validar y autorizar el resultado actual, no una propuesta obsoleta.
- Aprobar una orden, ratificar una modificación y confirmar un egreso NO son el
  mismo comando. Conservar reglas por rol/estado y efectos propios.
- Proteger reintentos y concurrencia antes de migrar nuevas decisiones financieras.
- Los pendientes desaparecen al resolver la operación original, no por un botón
  genérico de cerrar tarea. Registrar actor, fecha y resultado sin pasos redundantes.
- No introducir un sistema de solicitudes de cambios de precio sin comprobar cómo
  se generan y ratifican hoy; la bandeja existente de pedidos activos no incluye
  todas las órdenes nuevas. No presentarla como cobertura total.

## Primer corte: ingreso y egreso nativos en Administración

Implementación inicial en `/app/admin/finanzas/cuentas/movimiento`:

- Acceso desde Inicio, Cuentas, cada cuenta activa y Herramientas.
- Reutiliza formulario y registro de Operaciones; agrega una acción de acceso
  exclusivamente Admin, sin nueva contabilidad ni service-role adicional.
- Preselecciona cuenta y tipo; rechaza enlaces a cuentas inactivas o no disponibles.
- Conserva moneda, tasa, fecha, motivo y campos opcionales; resultado y enlace a
  movimientos del día. Los pagos de clientes siguen registrándose en sus órdenes.
- Bloqueo inmediato de doble envío en el formulario y edición deshabilitada durante
  el envío. Esto NO equivale a idempotencia en base de datos ante pérdida de conexión:
  el registro existente aún requiere ese endurecimiento antes de certificar reintentos.
- No se cambia el umbral vigente de egresos de Master ni se autoaprueban solicitudes
  existentes. Admin ya confirma sus propios registros según la regla actual.

Actualización posterior: transferencias nativas con comprobante e identidad de
reintento implementadas en el corte `ADMIN_TRANSFERS_UI_2026-09-12.md`.
Para ingresos/egresos siguen pendientes el comprobante por ID de operación y
reintentos garantizados en base de datos. También sigue pendiente la prueba
funcional completa con sesión Admin en la interfaz. La bandeja de autorizaciones
ya tiene un primer corte individual; su cobertura integral y cierres siguen en el
bloque 2, con límites documentados en `ADMIN_AUTHORIZATIONS_2026-09-12.md`.

## Verificación del primer corte

- 137 pruebas aprobadas: 118 Admin existentes, 6 seguridad y 13 del flujo operativo
  y su política. Casos nuevos ejecutan la acción real con dependencias de sesión y
  base de datos simuladas: USD/VES, comisión, ingreso, rechazo por rol, cuentas
  inactivas, error de escritura y navegación contextual.
- Compilación de producción y tipos de aplicación aprobados. Primera ejecución
  bloqueada por descarga de Google Fonts; repetición con red aprobada.
- ESLint de archivos nuevos y formulario compartido sin errores.
- Consulta real de solo lectura: 16 cuentas activas con moneda admitida, tasa activa
  disponible y RLS de movimientos habilitado. No demuestra por sí sola toda la
  política de permisos ni sustituye una prueba de escritura autenticada.
- Sin migraciones, cambios de roles ni transacciones sobre dinero real.
