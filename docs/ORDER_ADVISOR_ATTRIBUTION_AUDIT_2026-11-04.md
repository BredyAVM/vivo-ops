# Auditoria de atribucion al editar ordenes

## Hallazgo

El encabezado de la orden identifica a quien la creo, no necesariamente al
asesor atribuido. La vista del Asesor filtra por `attributed_advisor_id` sin
excluir ordenes creadas en Master.

El editor compartido de Master usaba el usuario que guardaba como asesor de
una orden de origen Master sin beneficio CRM. Era una regla valida al crear,
pero incorrecta al editar. La edicion operativa ahora conserva el asesor
guardado, incluso si es nulo. La seleccion de asesor, el flujo de CRM y la
asignacion separada de Mostrador se mantienen. Los cambios de asesor registrados
por el editor guardan ahora los identificadores anterior y nuevo.

## Orden 3777

Los eventos 36569 (creacion), 36570 (edicion inicial) y 36571 (aprobacion)
tenian como destinatario al asesor original. El evento 36572, a las 15:52 del
03/11/2026 en Caracas, registra el cambio de asesor al usuario que edito.
No habia ajuste administrativo explicito ni beneficio CRM vinculado.

Se restauro solo esa atribucion, sin cambiar creador, estado, precio, pago,
cliente, productos ni inventario. Evento de correccion: 36713. Se comprobo
primero con ROLLBACK y despues con lectura independiente tras COMMIT. La orden
entregada aparece al consultar con el filtro del asesor original y conserva
USD 74.50 pendientes. No se recalcularon cierres de comisiones.

Runbook acotado: `tools/orders/restore-3777-advisor-attribution.sql`. Por defecto
revierte la transaccion y no es una receta para cambiar otras ordenes.

## Alcance historico

56 ordenes registraron al menos un evento de edicion con cambio de asesor.
En 30 (incluida 3777), el ultimo de esos eventos no registro cambio de origen,
la orden sigue siendo de Master y el editor coincide con el asesor actual,
distinto del creador. No se encontro un ajuste administrativo de asesor
posterior a ese evento en esas 30. Seis de ellas se editaron desde octubre.

29 candidatas pendientes, **no errores confirmados**:
5, 27, 56, 57, 173, 280, 377, 441, 443, 467, 641, 681, 776, 851, 949,
1247, 1282, 1585, 1780, 1842, 1973, 2131, 2471, 2590, 3406, 3432, 3440,
3468 y 3497. No reasignar por creador/editor sin corroborar atribucion previa,
selecciones expresas, beneficios y cierres. No se tocaron esas ordenes.

## Verificacion y limite

27 pruebas de atribucion, precios protegidos y persistencia, y chequeo de
tipos de la aplicacion. La lectura autenticada de la orden por atribucion paso.
En la comprobacion aislada del saldo con el rol authenticated, la funcion
financiera fallo por permisos de delivery_settlements. Se confirmo el saldo
con la lectura administrativa; no se alteraron permisos ni se afirma una
prueba de extremo a extremo en la interfaz.
