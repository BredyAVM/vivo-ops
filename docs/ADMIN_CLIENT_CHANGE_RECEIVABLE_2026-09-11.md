# Cambio con diferencia por cobrar — 2026-09-11

## Regla aprobada

Si corresponde entregar USD 4,73 y solo hay USD 5, se registra la salida real
de 5, se consume 4,73 de fondo y se agregan 0,27 por cobrar a la orden. No se
crea saldo negativo del fondo ni se aumenta artificialmente la facturación.
La diferencia se cobra mediante un pago habitual o Administración puede usar
el cierre de redondeo existente, con sus permisos y límite vigentes.

## Implementación

- Dashboard y Ops llaman al mismo comando `settle_client_fund_payout_v1`.
- Recibo protegido por solicitud estable; actor, orden, cliente, cuentas,
  monedas, tasas, importes, fondo consumido, diferencia e historial vinculados.
- Transacción: bloqueo de orden, cuentas ordenadas y cliente; dinero, fondo,
  recibo y ambos historiales juntos. Solo Master/Admin; anulación solo Admin.
- Confirmación explícita del importe de deuda mostrado. Si el saldo cambia,
  se rechaza sin escribir y se pide actualizar. No hay nuevo campo obligatorio.
- No es un préstamo: requiere fondo positivo y orden no cancelada; el cambio
  adicional no puede superar lo abonado a esa orden.
- Anulación desde Cuentas deriva el grupo completo y restaura solo el fondo
  consumido; elimina el efecto de la diferencia. Reintento no duplica abonos.
- Movimientos certificados inmutables; restricción diferida impide agregar
  líneas ajenas, quitar miembros o cambiar parcialmente el estado del grupo.
- Confirmar un reporte con cambio mayor también admite la diferencia aceptada
  por Master/Admin. Retenciones y Counter no reciben esta nueva facultad.
  Clientes antiguos sin `expectedChangeDebtUsd` conservan el límite anterior.
- Lectura canónica descuenta únicamente la diferencia del payout, no toda la
  devolución del fondo. Corrige también cobertura Bs del cambio certificado
  nuevo para que el pago original no cierre falsamente los 0,27 pendientes.
- Asesor puede leer evidencia financiera de sus propias órdenes mediante RLS;
  no adquiere autorización para entregar fondos ni leer órdenes ajenas.
- El cierre por redondeo Dashboard ahora usa el saldo canónico, como Ops.

## Verificación

Pruebas SQL sintéticas bajo ROLLBACK: 4,73→5, cambio al confirmar un pago,
mezcla USD/VES, pago móvil posterior, devolución exacta sin deuda, reintentos,
cambio de solicitud, deuda no aceptada, errores tardíos de historial, reversión
del fondo, inmutabilidad, permisos y lectura del asesor. Suite anterior de
confirmación incluida como regresión. Compilación Next.js y pruebas Node.
No se registraron operaciones comerciales reales para probar.

## Límites que permanecen

- No corrige automáticamente el pedido histórico citado ni reconstruye
  entregas antiguas: primero se debe identificar y conciliar su evidencia.
- No migra cancelaciones, nómina, uso independiente de fondo ni conciliación.
- Redondeo conserva su flujo existente: todavía no se convirtió en un comando
  atómico propio. Anular un cambio después de un redondeo puede dejar saldo a
  favor; el redondeo es una decisión separada, no se revierte silenciosamente.
- La identidad de reintento vive en el formulario; recargar/cerrar y volver
  a abrir es una nueva intención. No es una prueba de carga concurrente.
- Los avisos de descubrimiento GraphQL no sustituyen RLS. Se revisan permisos
  y políticas; los avisos anteriores del proyecto no se declaran resueltos.
- Publicación: integración Git de Vercel, migración primero y comprobación
  del despliegue después. Sin nuevas dependencias ni rediseño general.
