# Centro administrativo de comisiones

Ruta: `/app/admin/finanzas/comisiones`.
Migración: `20260910163627_admin_finance_commissions_read_v1.sql`.

## Implementado

- Consulta compacta y actual de períodos, cierres, snapshots relevantes y
  referencias de pagos. No descarga las listas de órdenes/productos del snapshot.
- KPIs y detalle por período, asesor y estado; paginación de presentación de 30
  cierres con totales de toda la selección.
- Lectores compartidos `getAdvisorCommissionCarryState`,
  `readAdvisorCommissionWorkflowSnapshot` y
  `getAdvisorCommissionClosureIdFromPaymentDescription`.
- Acceso directo al cálculo/conformidad/pago en el módulo vigente y a sus
  secciones de auditoría. Ninguna nueva operación financiera o aprobación.
- Cierres finalizados de asesores inactivos permanecen visibles. Preliminares
  no elegibles quedan fuera del total y se informa su número.
- Cálculos anteriores al período no se presentan como generación cero.
- Retenciones legacy derivadas, conformidades ausentes, discrepancias de
  snapshot y pagos sin vínculo suficiente quedan explícitos.

## Decisiones contables

La comisión retenida puede incluir arrastres. Por ello se selecciona un único
período y no se suma una supuesta obligación actual de todas las quincenas.
La liquidación preliminar no es una obligación conformada. P10 usa solamente
cierres `closed` con conformidad y snapshot compatibles; excluye `paid`.

El esquema no contiene relación estructural pago–cierre. Los abonos confirmados
con descripción reconocida son una pista auditable, no certificación contable.
P11 se mantiene no disponible para obligaciones positivas: no se considera
pagada una comisión por su etiqueta ni se inventa saldo cero. Si no existen
obligaciones conformadas en la selección, ese conjunto sí mide cero; no significa
que la generación preliminar o el resto de períodos sea cero.

## Verificaciones

- 69 pruebas Admin, 77 del motor de comisiones y 6 de seguridad aprobadas.
  Doce pruebas nuevas cubren el contrato, los casos contables y la protección.
- Compilación de producción y comprobación de tipos de aplicación aprobadas.
- Prueba real como Admin: 7 períodos, 43 cierres, 5 asesores actualmente
  habilitados y 2 abonos identificados por descripción al corte de la prueba.
- La primera lectura de elegibilidad usando directamente roles se descartó:
  RLS permite al usuario leer sus propios roles, no los de todos los asesores.
  La implementación final reutiliza `get_advisor_profiles()` y el mismo filtro
  de perfil activo/habilitado del módulo existente, sin ampliar permisos.
- Respuesta real pasada por el parser y modelo de presentación de la aplicación.
- Agosto 02: 5 cierres, bruta USD 713,89 y conformada USD 608,24. El pendiente
  exacto sigue bloqueado por falta de relación estructurada de pagos.
- Septiembre 01: 5 snapshots preliminares guardados el 30 de agosto, antes del
  inicio del período. Se advierte que requieren actualización, sin recálculo
  automático ni publicación de esos ceros como estado actual del negocio.
- RPC real devuelve datos como Admin y rechaza anónimo, autenticado sin Admin
  y Master sin rol Admin. La consulta midió 113,931 ms en la muestra actual;
  esta observación no garantiza el rendimiento futuro.
  Usa `SECURITY INVOKER`, `search_path = ''`, identidad autenticada y comprobación
  de rol; mantiene todas las políticas RLS de las tablas consultadas.
- El asesor de seguridad no señala la nueva función.
- La revisión visual autenticada depende de una sesión Admin en el navegador;
  no se omite el login ni se fabrican sesiones para simularla.

## Pendiente para cerrar P11

Crear relación estructurada entre abonos y cierres para pagos nuevos, mantener
atomicidad al registrar pago y actualizar cierre, y conciliar el historial con
evidencia. No vincular automáticamente pagos ambiguos ni convertir un estado
`paid` sin respaldo en un movimiento ficticio. Esta parte no se ejecutó en este
bloque de lectura y debe verificarse antes de publicar deuda exacta por pagar.
