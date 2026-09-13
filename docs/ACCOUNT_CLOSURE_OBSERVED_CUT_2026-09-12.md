# Conciliación por saldo observado

## Regla confirmada

El administrador introduce el saldo exacto que ve en el banco en el momento de
conciliar. No significa esperar al final del día. Puede haber varias
observaciones de una misma cuenta en el día, con horas distintas.

Fuentes canónicas consultadas:

- FINANCIAL_GOVERNANCE_POLICY_2026-06-16.md: cierre como fotografía; fecha de
  operación separada de fecha de revisión; diferencias heredadas.
- FINANCIAL_CLOSURE_DATETIME_2026-06-30.sql: bancos, puntos, cajas y billeteras
  admiten varios cierres en el mismo día; closure_at identifica el momento.
- FINANCIAL_OPERATIONS_MANUAL_2026-06-18.md y
  FINANCIAL_CLOSURE_IMPLEMENTATION_PLAN_2026-06-16.md.
- ADMIN_V2_FINANCIAL_REFERENCE_CASES_2026-09-08.md: RF-03, RF-13 y RF-14.

Esto corrige la distinción diaria/intradía conservada por la implementación
atómica del 11 de septiembre. No cambia las fotografías guardadas anteriormente.

## Implementación

- Vista previa y guardado calculan el corte con account_closure_cut_v2.
- El cierre anterior se selecciona por closure_at, created_at e id, nunca
  priorizando la fecha descriptiva frente al momento real.
- El saldo contado anterior (o la línea base) inicia el cálculo; POS conserva
  su tratamiento de lote desde cero y exclusión del retiro de cierre vinculado.
- Los movimientos confirmados se delimitan con una misma regla temporal para
  el cierre y las posiciones de Admin. Master carga esa misma proyección.
- La fecha de operación permanece inmutable: confirmed_at solo delimita qué
  registros estaban confirmados en el corte. No se usa como fecha de facturación
  ni como fecha de flujo de tesorería.
- Una operación de fecha anterior al día del ancla, confirmada después, no se
  suma automáticamente al saldo observado como dinero nuevo. Debe revisarse
  frente a la diferencia histórica y su resolución, sin reescribir el cierre.
- Admin permite introducir segundos y tomar la fecha/hora actual explícitamente.
  Cambiar el corte invalida la vista previa anterior. Reintentos inciertos
  mantienen el identificador y los mismos datos.
- Master deja de rellenar el saldo contado con el esperado y de recurrir a
  una segunda fórmula local mientras se consulta la vista previa.
- Los comandos antiguos aceptan todavía HH:mm y su valor por omisión para
  compatibilidad; la pantalla nueva envía fecha y hora explícitas.
- Solo Master/Admin pueden consultar las nuevas funciones públicas. Las
  calculadoras y sus movimientos internos no se exponen a authenticated.

## Invariantes conservadas

- Un cierre no crea ingresos, egresos, ajustes ni traspasos.
- Una diferencia genera el pendiente permitido por el perfil, no dinero ficticio.
- Caja/POS siguen sujetos a sus reglas de diferencia cero.
- El traspaso de POS al banco sigue siendo una operación separada.
- Identificador estable, comprobante original, controles de secuencia y anulación.
- Ningún cambio masivo de cierres, movimientos, tasas o conciliaciones históricas.

## Alcance de la evidencia temporal

El ledger actual registra la fecha bancaria, pero no siempre la hora bancaria
real. No puede deducirse si una operación de ese mismo día reportada después
ya estaba incluida en el saldo que el usuario observó. En ese caso la diferencia
se concilia con evidencia; no se inventa una hora de operación ni una resolución.
Esta entrega no añade una vinculación automática de reportes tardíos.

Las lecturas históricas utilizan el estado actual disponible del ledger; no
constituyen una reconstrucción bitemporal completa de registros modificados
después. Las fotografías almacenadas sí conservan sus importes originales.

Se mantiene el protocolo de bloqueo del comando atómico previo. No se certifica
serialización total con todos los escritores antiguos del ledger que no toman
ese mismo bloqueo. La vista previa es informativa y el guardado recalcula.

## Verificación

- Suite Admin, operaciones administrativas y límites financieros.
- account-closure-observed-cut.rollback.sql: segundos, línea base intradía,
  dos cierres bancarios diarios, pagos retrofechados, coincidencia con posición
  Admin, más de 1.000 movimientos, roles y acceso a funciones privadas.
- account-closure.rollback.sql: reintentos, fallos al guardar comprobantes,
  rollback de diferencias, dependencia entre cierres, anulaciones, caja, POS y VES.
- Ambas suites SQL usan cuentas sintéticas dentro de transacciones revertidas.
  No registrar cierres reales para comprobar la interfaz.
- Compilación final exitosa; 182 pruebas automatizadas aprobadas. Lint limpio
  en los archivos nuevos de cierre; el panel Master conserva exactamente los
  24 errores y 53 advertencias preexistentes, sin mensajes nuevos.
- El asesor de seguridad mantiene los mismos seis grupos de advertencias
  preexistentes y sus cantidades; no certifica que toda la base esté saneada.
- Migración aplicada: 20260913000157_account_closure_observed_cut_v2.
