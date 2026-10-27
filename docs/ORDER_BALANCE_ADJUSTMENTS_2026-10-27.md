# Cierre separado de saldos — 27/10/2026

## Regla aprobada

Cerrar un faltante perdonado o un cambio voluntariamente cedido no renegocia la
venta. Conserva el precio USD/Bs, descuentos, impuestos, ítems y condiciones de
comisión. El cobro real continúa siendo el cobro real, no se aumenta para simular
que el cliente pagó lo perdonado. La diferencia queda en un ledger independiente
y en el historial administrativo de la orden.

- Faltante: solo Administración, máximo USD 0,50 inclusive. El usuario amplió
  explícitamente el límite anterior de USD 0,09 el 27/10/2026.
- Cambio cedido al confirmar: Administración, máximo USD 1,00, límite existente.
- Counter conserva su cierre de remanentes de hasta USD 1,00 y su débito exacto
  del fondo previamente acreditado. No hay otro ingreso o egreso de efectivo.

Ampliación aplicada mediante `20261027142431_order_shortfall_half_dollar_limit.sql`:
solo modifica el techo de autorización del comando y sus dos pantallas. Pruebas
con USD 0,09 / 0,10 / 0,49 / 0,50 en USD y VES; USD 0,51 rechazado incluso si se
envía un saldo esperado de 0,50. Reintentos, caja, precio y comisión sin cambios.
- La lectura canónica agrega esos ajustes únicamente al pendiente/saldo a favor;
  no los incorpora a facturación ni al dinero confirmado. Cero pendiente puede
  significar cobro completo **o** cobro más ajuste documentado.

## Implementación

`20261027141044_separate_order_balance_adjustments.sql` crea un ledger vacío, sin
backfill. Verifica las versiones instaladas antes de modificar las funciones.
No actualiza órdenes, cobros ni cierres de comisiones históricos al instalarse.

Los dos formularios de cierre usan `close_order_balance_difference_v1`, con
autorización en servidor y base, bloqueo de orden, saldo esperado y una identidad
estable de reintento. Doble clic/reenvío no produce un segundo ajuste. Solicitud
alterada, saldo cambiado u orden cancelada se rechazan sin escrituras parciales.
Historial y ledger se guardan en la misma transacción.

El cierre de excedente se integra en la confirmación atómica ya existente, con
la identidad del reporte. Su cálculo sigue siendo incremental: no absorbe un
saldo a favor anterior que pertenezca a otro pago.

Los ajustes conservan los movimientos confirmados que respaldaban el saldo. Si
uno se anula, el ajuste deja de aplicarse sin borrar su evidencia ni restaurar
precios antiguos. Las anulaciones de cierres **anteriores**, que sí cambiaban el
precio, mantienen su mecanismo de reversión registrado; no se ejecuta ninguna
anulación o reparación histórica automáticamente.

La tabla permite solo lectura con RLS por orden. La primitiva de escritura no
se expone a roles de API. Las funciones privilegiadas cierran `search_path` y
comprueban permisos. Una protección rechaza el viejo cierre que intentara
cambiar el precio desde una pestaña abierta de la versión anterior.

La interfaz identifica el ajuste, su importe y que precio/comisiones no cambian.
El detalle se obtiene al abrir la orden, sin cargar nuevos históricos al inicio.

## Verificación reproducible

`tests/admin/order-balance-adjustments-db.mjs` instala las funciones vigentes y
la migración sobre PostgreSQL aislado (PGlite), con registros ficticios:

- precio/efectivo/base de comisión antes y después;
- USD y VES, cambios de tasa, faltante y excedente;
- reenvío exacto, solicitud alterada y saldo desactualizado;
- incremento autorizado posterior del precio y pago adicional;
- anulación de pago o cambio, y reversión del cierre antiguo;
- falla tardía del historial con rollback completo;
- Counter y fondo, permisos de Administración, anónimo y asesor ajeno;
- conservación exacta de cierres pagados y bloqueo de la acción antigua.

No ejecuta operaciones reales ni es una prueba de carga concurrente. Se conserva
el motor de comisiones y el comportamiento de conversión precisa; no se cambian
los permisos de conceder descuentos. La ampliación posterior del límite de
faltantes a USD 0,50 no modifica el límite de cambio cedido de USD 1,00.

## Publicación

Pruebas y compilación antes de aplicar la migración. Comparación de huellas de
los cierres pagados y órdenes con cierres anteriores antes/después de instalarla;
ledger nuevo vacío. Publicación de la aplicación por la integración Git habitual.
No usar cobros o cierres reales para comprobar la interfaz.

## Evidencia de esta entrega

- 14 pruebas del nuevo flujo y 198 de regresión financiera/comisiones aprobadas;
  las 6 pruebas de frontera financiera también aprobaron. Compilación de
  producción y TypeScript correctos.
- Suite administrativa general: 129/130; el caso antiguo que prohíbe cualquier
  consulta dentro de Admin ya falla en HEAD por Evaluación/Premios. Esas cuatro
  pantallas no se modifican en esta entrega. No se debilita esa prueba.
- Revisión de lint frente a HEAD: ningún error o aviso nuevo; los archivos
  heredados conservan hallazgos anteriores. Se elimina código financiero muerto.
- Tras instalar: 13 cierres pagados y 67 órdenes con cierre anterior conservan
  exactamente las huellas previas, incluyendo su estado financiero. Ledger nuevo
  vacío; sin acceso anónimo ni escrituras directas de la aplicación.
- Asesor de seguridad: aviso nuevo de visibilidad del **nombre/esquema** de la
  tabla para autenticados por su SELECT necesario para el lector invocador;
  filas protegidas por RLS, probadas para asesor propio/ajeno. No es acceso
  anónimo ni escritura pública. [Descripción del aviso de Supabase](https://supabase.com/docs/guides/database/database-linter?lint=0027_pg_graphql_authenticated_table_exposed).
