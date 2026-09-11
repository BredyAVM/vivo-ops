# Cierres de cuentas atómicos — 11 de septiembre de 2026

Migración aplicada y probada nuevamente: `20260911151418_account_closure_atomic_v1.sql`.
Asesor de seguridad: descubribilidad de nombres de tablas en GraphQL por SELECT;
las filas de comprobantes y reversiones siguen limitadas a Admin/Master por RLS.

El formulario actual usa un comando con sesión normal y mantiene una identidad
de envío durante sus reintentos. No se añaden campos ni pasos administrativos.
Master/Admin crean; solamente Admin anula, igual que antes.

Registro: cuenta bloqueada, cálculo del corte, cierre, diferencia pendiente de
conciliación cuando aplica y comprobante protegido en una sola transacción.
El comprobante guarda cuenta/moneda, corte, perfil, cierre anterior, línea base e
identificadores/importes de los movimientos utilizados. No es una estimación
reconstruida después con datos que pudieron cambiar.

Se mantienen las reglas existentes:

- Bancos y otras cuentas diarias: corte por fecha.
- Efectivo/POS: corte por fecha y hora de registro.
- POS: no suma el conteo del cierre anterior y excluye su traslado reconocido.
- Cuentas configuradas con diferencia cero: no cierran con diferencia nativa.
- USD/VES: importe nativo y valoración histórica en USD permanecen separados.
- No se crea un traslado POS nuevo por asumir el significado de una configuración:
  esta entrada de registro de cierre no lo hacía antes y mantiene ese alcance.

Anulación: movimientos ligados por la referencia vigente, pendientes abiertos,
estado del cierre y evidencia de reversión se guardan juntos. Reintentar no
duplica. Una diferencia ya resuelta o un cierre posterior dependiente bloquea la
operación con explicación; no se destruye la resolución ni se falsea su saldo.
Tampoco se inserta un cierre previo a otro activo o a la línea base vigente.

Verificación rollback con cuentas sintéticas: error al guardar el comprobante
revierte cierre y diferencia; error al anular revierte ambos; reenvío, datos
distintos, mismo corte, dependencias, POS, dos cortes de efectivo, bancos, VES,
línea base, diferencia ya resuelta, Master y roles no autorizados. Compilación de
producción y tipos de aplicación aprobados. No se registraron cierres reales.

Límites: el preview conserva la implementación anterior de lectura; el guardado
recalcula de forma autoritativa. No se migra el alta/anulación de líneas base ni
la resolución financiera de diferencias. Escritores históricos que no bloquean
la cuenta no quedan certificados por este cambio. Las referencias de traslados
antiguos se conservan como convención histórica, no como vínculo certificado nuevo.
