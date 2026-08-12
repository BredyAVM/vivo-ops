# Certificación operativa · Cocina

## Validación automática

```powershell
npm.cmd run test:kitchen
npm.cmd run build
```

Después de aplicar `kitchen_inventory_shifts_v1`, ejecutar completa la prueba
`KITCHEN_INVENTORY_SHIFT_TRANSACTION_TESTS_2026-08-11.sql`. Finaliza con
`ROLLBACK` y no conserva conteos, movimientos ni saldos de prueba.

## Matriz física Android

Probar en el único dispositivo instalado de Cocina:

1. App cerrada: enviar una orden nueva; debe aparecer push con icono de Cocina y abrir `/app/kitchen`.
2. App en segundo plano: modificar una orden en preparación; debe vibrar, refrescar y destacar la orden exacta.
3. App abierta: tomar el pedido con 10, 20 y un ETA manual; el Asesor atribuido debe consultar el mismo tiempo.
4. Marcar lista: Cocina, Master y el Asesor deben reflejar el nuevo estado sin recarga manual.
5. Incidencia: reportarla, marcarla revisada/resuelta/reabierta desde Master y comprobar cada estado en la tarjeta correcta.
6. Sin red: las acciones deben bloquearse sin duplicar; al recuperar conexión la cola debe reconciliarse.
7. Push: tocar `Probar push`; solo la suscripción con alcance `kitchen` debe recibirlo.
8. Inventario: abrir un **Conteo por turno**, salir y reanudarlo; presentarlo y abrir otro para la misma fecha. Confirmar que cada cierre conserva fecha, hora y responsables sin numerar turnos.
9. Solicitudes: crear conteo, reconteo y recepción esperada desde Master; Cocina debe recibir push, contador y actualización en vivo.

Registrar fecha, usuario, dispositivo, versión desplegada y resultado de cada punto. La prueba física no se considera aprobada hasta observarla en Android; el build por sí solo no la sustituye.
