# Bloque: pagos nuevos de comisión vinculados

## Alcance

El formulario existente de Comisiones conserva cuenta, importe, fecha, tasa,
comisión bancaria y referencia. Ahora llama a un comando único: abono, gasto
bancario, recibo estructural y estado del cierre se confirman juntos o se revierten.
La clave de envío se genera en el servidor y viaja oculta en el formulario.
Reenviar la misma clave y datos devuelve el recibo, no inserta un segundo abono.
Una nueva carga del formulario crea otra clave: no es deduplicación universal
de transferencias bancarias ni conciliación automática con el banco.

La operación privada verifica Admin persistido, bloquea el cierre, comprueba la
cuenta activa, la conformidad, el cálculo guardado, las deducciones, el saldo y
los importes nativos. El gasto bancario nunca reduce la deuda con el asesor.
Una comisión bancaria equivalente a menos de 0,01 USD se rechaza explícitamente:
el ledger actual no admite equivalencia cero. No se cambió esa precisión.

El lector V2 distingue evidencia estructural de referencias históricas. Solo
los cierres conformados con pagos estructurales íntegros, sin referencias antiguas
mezcladas, muestran saldo por pagar conciliado. Un cero o un estado `paid` antiguo
no certifican un pago. El lector V1 permanece para compatibilidad.

## Correcciones

En Auditoría de comisión → Abonos se puede anular un registro nuevo completo,
incluido su gasto bancario. Requiere motivo y confirmación porque invalida ambos
registros contables; no es una transferencia ni una devolución bancaria.
La anulación y el regreso del cierre a `closed` son atómicos e idempotentes.
Se conservan recibo original, movimientos anulados, motivo, autor y fecha.
No se permite alterar un movimiento vinculado aisladamente desde otras rutas.
El historial de anulaciones aparece en la misma sección de Abonos.

Los cierres con recibos estructurales mantienen su cálculo protegido incluso
si se anulan todos sus abonos: corregir una fórmula ya pagada requiere una
rectificación contable específica, no borrar la historia ni recalcularla en sitio.

## Seguridad y compatibilidad

- API pública `SECURITY INVOKER`; comandos privados `SECURITY DEFINER` con
  autorización Admin explícita, `search_path=''` y grants restringidos.
  La elevación es deliberada: los clientes no pueden insertar/alterar recibos ni
  anulaciones directamente. No se usa para resolver un error de acceso a tablas.
- Tablas nuevas con RLS, lectura solo Admin/Master y sin escritura directa de
  authenticated/anon/service_role. Los comandos rechazan Master sin Admin.
- Bloqueos por clave y cierre. Los cambios de deducciones bloquean el mismo padre.
- Un formulario antiguo no puede agregar dinero sin vínculo a un cierre que ya
  usa recibos: una comprobación diferida valida el vínculo al final de la transacción.
- No se alteran roles, cuentas, tasas, pagos históricos ni fórmulas comerciales.
- No se certifican ni se migran automáticamente pagos identificados por texto.
  Si aparecen en un cierre, registrar un nuevo abono exige conciliar primero esa
  evidencia. Esto evita descontarlos por conjetura o ignorarlos y pagar de más.
- Las notificaciones del abono siguen siendo best-effort y deduplicadas por
  movimiento; no forman parte de la transacción financiera.

## Verificación

Migración aplicada: `20260910223237_commission_payment_atomic_v1.sql`.
Lectura real V2 comprobada: 43 cierres; ningún recibo de prueba persistido.
El asesor de seguridad señala descubribilidad de las dos tablas nuevas en el
esquema GraphQL autenticado (metadatos, no permiso sobre sus filas). Es una
exposición de esquema aceptada para su lectura desde la aplicación: RLS restringe
filas a Admin/Master y el ensayo de asesor devuelve cero. No hay grant a anónimo.
No se amplían permisos para eliminar el aviso. Referencia:
https://supabase.com/docs/guides/database/database-linter?lint=0027_pg_graphql_authenticated_table_exposed

- 82 pruebas Admin, 79 de comisiones y 6 de seguridad: 167 aprobadas.
- Prueba SQL transaccional con fixtures sintéticos y ROLLBACK:
  abono parcial/final, USD/VES, gasto separado, reenvío, colisión de clave,
  sobrepago, error forzado después de insertar dinero, integridad del estado,
  protección de cálculo/deducciones/recibos, anulación conjunta, reenvío de
  anulación, doble anulación, denegación de anónimo y asesor.
- Build de producción y comprobación de tipos de aplicación aprobados.
- No se ejecuta un pago o anulación real para probar la interfaz en producción.
- No se realizó un ensayo de concurrencia con dos sesiones independientes;
  la serialización está implementada con bloqueos transaccionales de PostgreSQL.

## Pendientes que este bloque no resuelve

1. Conciliar los pagos históricos usando evidencia real; no inventar transferencias.
2. Rectificación de fórmulas/cierres con historia de pagos y anulaciones.
3. Migración general de escrituras de cuentas y sus políticas de corte/conciliación.
4. Snapshot de nuevos costos de Delivery y brecha histórica.
5. Pantallas V2 propias de clientes/equipo/notificaciones, tareas de otros dominios
   y rediseño visual general.

No implica retirar el panel vigente ni dar por finalizada toda la hoja de ruta.
