# Preparacion de piloto de Master Ops - 2026-07-23

Este documento registra el cierre operativo de `/app/master/ops`. Es una guia de
validacion del piloto y no sustituye las reglas canonicas enlazadas desde
`docs/HANDOFF_2026-07-22.md`.

## Estado de salida

Estado tecnico: listo para un piloto controlado, sujeto a completar el smoke test
con un usuario master y ordenes designadas para prueba.

La consola `/app/master/dashboard` se mantiene intacta como respaldo operativo.
Master Ops no depende de navegar a ella para completar las acciones incluidas en
este piloto.

## Cobertura auditada

| Area | Estado | Validacion principal |
| --- | --- | --- |
| Entrada y navegacion | Lista | El rol master entra a `/app/master/ops` y los controles del modulo permanecen en Ops. |
| Fecha operativa | Lista | Todo el control abre el calendario y permite escoger una fecha especifica. |
| Bandejas | Lista | Operacion, Acciones y Seguimiento abren sus vistas sin salir del modulo. |
| Consulta | Lista | Filtros del dia y busqueda remota permiten localizar y abrir una orden. |
| Creacion y edicion | Lista | El master puede crear y editar con las validaciones y semantica existentes. |
| Flujo de orden | Lista | Aprobar, devolver, reaprobar, enviar/tomar en cocina, preparar, asignar, despachar y completar. |
| Pagos | Lista | Reportar, confirmar y rechazar; respeta la regla canonica de origen VES/USD. |
| Finanzas operativas | Lista | Fondo de cliente, vuelto, redondeo y proteccion de precio disponibles segun el caso. |
| Trazabilidad | Lista | Eventos, notas, ajustes y resumen centralizado de WhatsApp. |
| Errores | Lista | Carga, detalle y mutaciones muestran fallo sin asumir exito. |
| Rendimiento | Lista | Detalle y bandejas se cargan bajo demanda; refresco por foco y antiguedad. |
| Movil | Lista | Tarjetas operativas en pantallas pequenas y tabla en escritorio. |
| Alertas | Lista | Activacion compacta en Ops, sonido en alertas importantes, refresco en primer plano y retorno a Ops desde notificaciones del dispositivo. |

## Requisitos ambientales

Antes del piloto deben estar presentes:

- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT`.
- Tabla `public.user_push_subscriptions` configurada.
- Permiso de notificaciones concedido en cada dispositivo master.
- Un usuario con rol `master` y datos de prueba identificables.
- Tasa activa vigente para las pruebas de pagos en bolivares.

## Smoke test obligatorio

Usar una orden de prueba por cada recorrido. No reutilizar una orden real activa
para probar cancelaciones o rechazos.

1. Iniciar sesion como master y confirmar que la entrada abre Master Ops.
2. Cambiar la fecha con el calendario, volver al dia actual y actualizar.
3. Activar `Alertas`; debe quedar en `Alertas ON` y sonar la prueba local.
4. Crear una orden desde Ops, abrirla desde la lista y editar un dato permitido.
5. Recorrer una pickup: aprobar, enviar a cocina, tomar, marcar lista y retirar.
6. Recorrer una delivery: aprobar, cocina, asignar interno o externo, en camino y entregada.
7. Devolver una orden al asesor, corregirla y confirmar que aparece para re-aprobacion.
8. Reportar un pago VES de un producto nacido en VES antes o el dia de entrega:
   el monto VES debe conservar el valor exacto, sin ida y vuelta por USD.
9. Reportar un pago posterior a la entrega y comprobar que usa el snapshot USD por
   la tasa del dia del pago.
10. Confirmar y rechazar reportes distintos; revisar estados, saldos y eventos.
11. Probar fondo de cliente, vuelto y cierre de redondeo en ordenes preparadas para ello.
12. Agregar una nota, revisar eventos/ajustes y copiar el mensaje de WhatsApp.
13. Desde un asesor, generar una orden o pago que requiera revision del master:
    Ops debe refrescarse, sonar si la alerta es importante y la notificacion debe
    volver a `/app/master/ops`.
14. Repetir apertura, bandejas y accion principal desde un telefono.
15. Cortar la conexion antes de una mutacion de prueba: debe mostrarse error y la
    interfaz no debe presentar la accion como exitosa.

## Criterio de aprobacion

El piloto puede comenzar cuando:

- los 15 pasos anteriores pasan;
- ningun control de Master Ops envia al master a Dashboard;
- los saldos y montos VES coinciden con la fuente canonica;
- una accion fallida no produce un estado visual falso;
- las alertas funcionan en el dispositivo que se usara durante el turno.

Detener el piloto si se detecta una mutacion duplicada, un saldo incorrecto, una
transicion de estado invalida o una perdida de trazabilidad. En ese caso se puede
usar Dashboard como respaldo operativo mientras se registra el numero de orden,
la accion, la hora y el mensaje observado.

## Registro de conformidad

- Usuario master:
- Dispositivo/navegador:
- Fecha y turno:
- Ordenes de prueba:
- Resultado:
- Incidencias:
- Responsable de aprobacion:
