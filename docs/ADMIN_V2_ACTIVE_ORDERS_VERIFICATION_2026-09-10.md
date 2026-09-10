# Admin — pedidos por entregar (P07)

## Alcance

Ruta `/app/admin/finanzas/pedidos`, accesible desde Inicio, Finanzas y navegación
administrativa. Lectura exclusiva para Admin. Las operaciones siguen en
`/app/master/ops?openOrder=<id>&tab=pagos`; no se introducen aprobaciones nuevas.

La aprobación vigente mueve `created` a `queued`; por ello `queued` forma parte
del compromiso activo. También se incluyen `confirmed`, `in_kitchen`, `ready`
y `out_for_delivery`. Órdenes entregadas/canceladas/devueltas a creación quedan
fuera. Las ya cubiertas y las de importe cero siguen contando para la operación.

La posición no equivale a ingresos realizados ni a una previsión de caja con
fecha comprometida. Agenda y pago son dimensiones distintas. No aplica aquí
el plazo de crédito de cinco días de la cartera entregada.

## Autoridad y controles

- RPC `admin_finance_active_orders_v1()`, sin fecha ni identidad del llamador
  recibidas como parámetros; usa `auth.uid()` y `user_roles.role = admin`.
- `SECURITY DEFINER`, `search_path = ''`, ACL explícita, sin permiso para `anon`
  ni `PUBLIC`. Sigue el límite financiero existente para invocar el calculador
  canónico sin abrir sus funciones privadas ni ampliar acceso al esquema privado.
- La aplicación usa la sesión del administrador, nunca una clave de servicio.
- Total y pendiente provienen de `get_order_financial_state`; cubierto es
  `clamp(total - pendiente, 0, total)`. Fondos/redondeos no se recalculan en UI.
- Un reporte por revisar no reduce deuda. Un saldo superior al total queda
  visible con alerta; no se fuerza una igualdad contable artificial.
- Fecha faltante/inválida no se sustituye por creación. Reaprobación pendiente,
  fecha ausente y saldo superior al total se marcan `Q3_incomplete`.
- El cargador rechaza datos ausentes, negativos, no finitos, identificadores
  duplicados, conteos fraccionarios, fechas inválidas, cortes incompatibles y
  diferencias de un centavo entre resumen y detalle; no los convierte en cero.
- SSR con paginación de presentación de 30 filas. Se consulta el conjunto activo
  completo, no el histórico entregado. Las cifras filtradas incluyen todas las
  páginas. No hay precarga de centros operativos ni consultas nuevas en Inicio.

## Verificación realizada

- Migración aplicada `20260910160132_admin_finance_active_orders_v1.sql`; nombre
  local alineado con la versión asignada por el historial remoto.
- 57 pruebas de administración y 6 de seguridad aprobadas; diez pruebas nuevas
  cubren contrato/casos financieros, estados, agenda, filtros, páginas, errores
  y controles de frontera.
- Compilación de producción y TypeScript de aplicación aprobados. La primera
  ejecución no pudo descargar Google Fonts por restricción de red; al permitir
  esa descarga terminó sin modificar fuentes o configuración de la aplicación.
- Consulta real como Admin: 12 pedidos; total USD 1.081,97; cubierto USD 741,85;
  pendiente USD 340,12. Son cifras de prueba al corte, nunca constantes de UI.
- Comparación independiente de las 12 filas contra la lectura financiera por
  lote: cero diferencias de total, cobertura y saldo; diferencia USD 0,00.
- La respuesta real también pasó el validador TypeScript de la aplicación.
- Llamadas reales como anónimo, autenticado sin identidad, no administrador y
  Master sin Admin fueron rechazadas con `42501`; Admin devolvió el resultado.
- `EXPLAIN ANALYZE` de la consulta: 92,223 ms en la muestra actual de 12 pedidos.
  Es una observación puntual, no una garantía de latencia futura.
- Asesor de seguridad: advertencia genérica de función privilegiada ejecutable
  por autenticados (`0029`), intencional y compensada por la comprobación interna
  de Admin verificada. No se interpreta como acceso libre a usuarios logueados.
  Referencia: https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable
- La inspección visual autenticada queda pendiente de sesión de administrador
  en el navegador disponible. No se ha sustituido autenticación con credenciales
  de servicio, sesiones fabricadas ni rutas públicas de datos de prueba.

## Límites y continuación

No incluye cotizaciones Bs agregadas, caja proyectada por fecha de pago,
comisiones, pasivos de delivery o costos. Se mantiene la separación con cartera
entregada. El siguiente bloque es integrar comisiones devengadas, retenidas,
conformadas y pendientes de pago usando su módulo y vínculos existentes.
