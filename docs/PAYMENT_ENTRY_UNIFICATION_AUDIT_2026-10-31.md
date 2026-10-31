# Unificación de captura de pagos y abonos

Fecha: 2026-10-31. Alcance autorizado: Asesor, Counter, Master y Administración.

## Resultado y contrato

Una sola interfaz `src/components/orders/OrderPaymentEntry.tsx` concentra fecha,
tasa diaria, importe y estimación. Los adaptadores conservan únicamente cuentas,
métodos, referencias, permisos y su confirmación operativa existente.

La norma vigente está en «Captura única de pagos y abonos en todos los módulos»
de `docs/FINANCIAL_CANONICAL_FLOW_2026-06-04.md`.

- Fecha real del pago, no fecha de carga; día inicial de Caracas.
- Una tasa diaria se selecciona automáticamente; varias requieren elección.
- El importe parcial conserva la tasa elegida aunque coincida con el saldo
  completo a otra tasa del mismo día. No se deduce otra tasa por el importe.
- «Completar saldo» usa la cotización autorizada; no hay obligación de saldar.
- Bs de origen protegido se cotizan desde el snapshot, sin ida y vuelta por
  USD redondeados. El servidor sigue siendo la autoridad del saldo.
- No hay consulta por tecla, sondeo ni lectura de historiales al abrir el módulo.
- Lecturas fallidas y respuestas tardías no habilitan el registro.
- Efectivo/Punto de Counter mantiene confirmación inmediata según cuenta;
  pagos digitales conservan verificación. No se amplían permisos.

## Eliminación de divergencias

Se retiraron las entradas y sugerencias duplicadas de Asesor, Counter,
`OrdersWorkspaceClient` (Master/Admin) y el formulario anterior de
`MasterDashboardClient`. No se cambió el resto del dashboard.

Ambos reportadores digitales usan `create_payment_report_on_date_v1`: fecha y
tasa nacen en la inserción, sin una actualización posterior con privilegios ni
reconstrucción de tasa desde un equivalente redondeado. Counter conserva su
motor atómico/idempotente y ahora no reemplaza la tasa por la última del día.

Migración aplicada y versionada:
`20261031210858_unified_explicit_payment_entry.sql`.
No agrega tablas ni ejecuta modificaciones de dinero o reportes existentes.

## Evidencia de validación

- `tests/counter/unified-payment-entry.test.mjs`: componente real, selección
  múltiple, tasa única, USD, Bs snapshot, abonos, completar saldo, errores,
  respuestas tardías y contrato de los cuatro adaptadores.
- Pruebas reales de pantalla del Asesor y Counter: fecha y tasa llegan sin
  reemplazo; revisión de importe y referencia de Punto se conservan.
- `tests/admin/payment-rate-protection-db.mjs`: comandos PostgreSQL reales en
  base aislada; Asesor/Master/Admin/Counter, pago parcial que coincide con otra
  tasa completa, permisos, reintento sin doble ingreso, cobertura anterior,
  snapshot y caso USD 45 / Bs 37.301,04 a 888,12 que deja USD 3.
- Regresiones aprobadas de precisión, límites financieros, confirmación
  atómica, workspace compartido, retorno del motorizado, deuda separada y
  protección de cierres. Las pruebas no registran dinero en producción.
- TypeScript de producción y compilación webpack aprobados. Lint focalizado
  sin errores nuevos; los errores previos del dashboard/acciones heredadas
  siguen fuera del alcance de este cambio.

Resultado automatizado: 78 pruebas de interfaz/contrato/regresión y 32 pruebas
PostgreSQL de tasas aprobadas, además de los chequeos aislados de cierres y
deuda del delivery. La compilación local usa las dependencias ya instaladas
(Next 16.2.6); el manifiesto conserva Next 16.3.8 para el despliegue, sin cambiar
dependencias ni la instalación compartida con otros módulos.

## Comprobación productiva sin escritura de dinero

Antes y después de aplicar la migración se conservaron exactamente:

- hash de reportes de 3628, 3676, 3677, 3685 y 3686:
  `8f2576a8367d247cf3d9c5f8a7a5e7a2`;
- hash de movimientos de esas órdenes: `1ed0ff80aed44b891c12341a018b25dc`;
- hash de todos los cierres: `58f5cd056dce00b7f47a1d4ed91497c1`;
- 3811 reportes y 5936 movimientos; no se creó un pago de prueba real;
- deuda 3628: USD 3; deuda 3677: USD 0,50.

La cotización de 3628 consultada con su Asesor devuelve ese mismo pendiente
con ambas tasas válidas del 28 de octubre: Bs 2.664,36 a 888,12 o Bs 2.666,70
a 888,90. Consultar no altera el pago ya confirmado ni sus USD 3 pendientes.
El diagnóstico de seguridad no agregó hallazgos ni modificó permisos.

No se ingresó dinero, confirmó un pago pendiente ni cerró una liquidación.
La aceptación visual final en el equipo del operador corresponde al despliegue;
las pruebas de interfaz automatizadas no sustituyen esa revisión presencial.
