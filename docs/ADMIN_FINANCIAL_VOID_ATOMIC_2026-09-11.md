# Anulación financiera atómica — 11 de septiembre de 2026

Migración aplicada: `20260911150021_financial_void_atomic_v1.sql`.
Compilación de producción y tipos de aplicación aprobados.

Ambas entradas Master de anulación llaman al mismo comando con sesión normal,
sin operaciones parciales con cliente de servicio. Admin y motivo siguen siendo
obligatorios. El servidor obtiene el grupo real desde el movimiento seleccionado.

En una transacción: bloqueo de orden/cuentas/movimientos/reportes/clientes,
reversión exacta del fondo vinculado, reversión del redondeo certificado cuando
sus totales siguen vigentes, anulación de todo el grupo, rechazo del reporte y
historial visible/canónico con comprobante protegido. El reintento no debita dos
veces el fondo ni repite el historial. Traspasos certificados se derivan a su
comando propio; comisiones se corrigen desde la liquidación.

Si el fondo ya fue gastado, no se anula nada. Si alguien cambió el total después
del redondeo, se exige revisar ese ajuste, sin sobrescribirlo. Metadatos ajenos al
redondeo se preservan, incluso cambios posteriores. Se corrige además la
normalización de metadatos opcionales JSON null al confirmar un redondeo nuevo.

Verificación transaccional: fallo al final revierte fondo/movimientos/reporte y
ambos historiales; anulación de pago con fondo, selección de la parte de cambio,
redondeo con y sin metadatos, reenvíos, fondo gastado, grupo incorrecto y permisos.
Las pruebas usan solo fixtures financieros sintéticos y terminan en ROLLBACK.

## Excepciones conservadoras

- Operaciones antiguas de Mostrador con fondo sin vínculo estructural o cambio
  digital no se desarman desde la anulación genérica. Se informa la necesidad de
  revisar la operación completa; no se adivina a qué crédito corresponde el fondo.
- No se anulan movimientos con referencia de cierre por fuera de Cuentas.
- No se reconstruyen redondeos históricos sin el comprobante de confirmación nuevo.
- Las devoluciones aprobadas de Mostrador ya tienen su propio comando transaccional;
  no se cambian sus autorizaciones ni se convierten en una simple anulación.
- No se cierran todas las rutas históricas de escritura de otras pantallas ni se
  agrega un bloqueo global de periodos/cuentas. No es una prueba de carga concurrente.

Estas excepciones deben seguir en el pendiente de conciliación y paridad: no
equivalen a certificar toda la historia financiera de VIVO Ops.
