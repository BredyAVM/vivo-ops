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

## Toma de pedidos y pantallas desactualizadas — 2026-11-11

Caso de referencia: orden 3913, error de producción a las 16:50:53 de Caracas
del 2026-11-10. El servidor rechazó una toma por estado incompatible; la interfaz
mostró el error minificado de React en lugar de explicar el cambio de estado.

Contrato de Cocina:

- `takeOrderForKitchenAction` verifica sesión, permisos e input; lee el estado con
  el cliente del usuario (sin permisos elevados). Si no está `confirmed`, no toma la orden.
- Si está `confirmed`, delega una sola vez en la acción canónica de Máster.
  Esa acción y su RPC no se modifican ni se duplican.
- Si la acción rechaza, vuelve a consultar el estado una vez. Nunca reintenta la
  escritura, reinicia `kitchen_started_at`, reemplaza el ETA ni reenvía eventos.
- Una orden ya tomada muestra un aviso informativo con su número y conserva el
  tiempo guardado. Las listas se actualizan tanto tras éxito como tras rechazo.
- Una consulta fallida no se interpreta como éxito. Los fallos técnicos permanecen
  en el registro; la pantalla pide revisar el estado antes de repetir una acción.
- Una referencia síncrona bloquea pulsaciones duplicadas antes del siguiente render.
  Máster, administrador y usuarios con posiciones combinadas conservan sus permisos.

`npm.cmd run test:kitchen` incluye las regresiones de la 3913: doble pulsación,
toma concurrente, fallo posterior a la escritura, estados posteriores/cancelados,
sesión/permisos, consulta fallida y fallo de transporte. Se ejecutan la acción y
el manejador reales con límites de servicios simulados; no se modifican pedidos vivos.

Validación del cambio: 51 pruebas de Cocina aprobadas (19 nuevas), ESLint sin errores
y comprobación TypeScript focalizada aprobada para los archivos de Cocina y sus
dependencias. La comprobación TypeScript global conserva errores en pruebas ajenas
y dependencias locales de pruebas; no se certificó un build global ni Android.

Prueba física pendiente: en el Android de Cocina, abrir una orden en cola, tomarla
desde Máster y pulsar la tarjeta desactualizada. Debe pasar a Preparando con un aviso
claro, conservando el inicio y ETA que ya guardó Máster. No certificar esta prueba
solo por pasar las pruebas automáticas.
