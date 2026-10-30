# Protección de cierres de efectivo

## Problema y decisión

Corregir un egreso anterior a un cierre dejaba su conteo como ancla antigua.
No corresponde crear otro egreso ni reescribir automáticamente un conteo físico.
Se protege el período cerrado y se reutiliza la anulación auditada administrativa.

## Implementación

- Protección en `money_movements`, para cuentas `cash`, sobre ambos lados de
  una corrección: monto nativo/USD, cuenta, moneda, signo, estado y fechas.
- Un cambio anterior al cierre se rechaza con el número del movimiento,
  número del cierre y cuenta. La transacción completa revierte sus efectos.
- Los movimientos nuevos posteriores y las notas no monetarias continúan.
- Los importes y fechas de un cierre de efectivo son inmutables. No se borra
  ni reactiva un cierre anulado. Su anulación requiere evidencia en
  `account_closure_reversals`, verificada al terminar la transacción.
- Los cierres se revisan desde el más reciente. El comando administrativo
  existente retira su ancla antes de anular un eventual traspaso legado;
  todo sigue siendo una transacción con auditoría y reintento idempotente.
- Escrituras de caja y cierres comparten bloqueo de cuenta. El cierre compara
  su saldo esperado con el corte canónico antes de guardarse.
- Counter reutiliza `account_closure_cut_v2` al cerrar y el predicado temporal
  y ajuste conciliado compartidos al leer. No se recorre el histórico completo
  en la bandeja ni se incorporan consultas nuevas al cliente.

## Operación

1. Ante el bloqueo, Administración abre Cuentas y revisa el cierre indicado.
2. Anula con motivo los cierres afectados, empezando por el último.
3. Corrige/anula el movimiento por el mecanismo autorizado correspondiente.
4. Verifica el efectivo y registra un nuevo cierre. No copia un conteo viejo
   ni crea un movimiento compensatorio para ocultar una diferencia.

No se cambia ninguna orden, pago, fondo o saldo al instalar esta protección.
La deuda comercial conserva su cálculo canónico. Una corrección real de un pago
posteriormente autorizada conserva sus propios efectos comerciales; esta
protección no introduce condonaciones ni modificaciones adicionales.

## Verificación

`tests/counter/cash-closure-protection-db.mjs` ejecuta las funciones reales
capturadas en PostgreSQL aislado: USD/VES, importes, anulación, eliminación,
cambio de cuenta/fecha, inserción retroactiva, notas, cierre obsoleto,
rollback integral, cierres sucesivos, anulación auditada y reintento sin duplicar.
`tests/counter/delivery-change-debt-db.mjs` mantiene la regresión de retorno
USD 40 menos cambio USD 10 y deuda de USD 0,50, incluso con custodia liquidada.

Sin tablas nuevas, sin índices duplicados, sin modificaciones de Dashboard
y sin reparación ni movimiento de dinero sobre la orden 3677.

Migración aplicada: `20261030203717_cash_closed_period_protection`.
Las 31 comprobaciones aisladas y la regresión de deuda pasaron. Después de
aplicarla, Counter y el lector financiero canónico muestran USD 109 para la
cuenta 7; la orden 3677 conserva USD 0,50 pendientes y USD 30 confirmados.
Las huellas de todos los movimientos y cierres de la cuenta 7 y la cabecera
de la orden son idénticas antes y después. Los tres controles privados no
conceden ejecución directa a anon/authenticated ni añadieron hallazgos de
seguridad sobre esas funciones.
