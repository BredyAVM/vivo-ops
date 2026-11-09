# Recuperacion autorizada de datos de documentos

El usuario autorizo recuperar exclusivamente los 14 clientes sin contradicciones
de la auditoria de factura/nota de entrega. No autorizo elegir una version para
los clientes 2117 y 3718, que permanecen intactos.

## Resultado verificado en Supabase

Se recuperaron 50 campos: ocho perfiles de factura y seis de nota de entrega.
Diez perfiles tienen los cuatro campos y cuatro se recuperaron parcialmente.
No se inventaron campos ausentes de la fuente.

| Cliente ID | Orden fuente | Perfil | Campos |
| --- | --- | --- | --- |
| 6273 | 3272 | Factura | 3 |
| 6248 | 22 | Factura | 4 |
| 631 | 156 | Factura | 4 |
| 6275 | 343 | Factura | 4 |
| 3798 | 2951 | Factura | 4 |
| 1409 | 718 | Factura | 4 |
| 5268 | 1911 | Factura | 4 |
| 5945 | 2704 | Factura | 4 |
| 6914 | 3433 | Nota de entrega | 1 |
| 2903 | 2813 | Nota de entrega | 4 |
| 4497 | 426 | Nota de entrega | 3 |
| 42 | 3519 | Nota de entrega | 3 |
| 4049 | 3448 | Nota de entrega | 4 |
| 818 | 646 | Nota de entrega | 4 |

El runbook acotado es tools/clients/recover-client-documents-2026-11-09.sql.
Lee las fuentes historicas, bloquea las fichas, vuelve a comprobar variantes
entre pedidos no cancelados y solo rellena vacios. Si aparece un valor actual
distinto, revierte toda la operacion. Comprueba que los demas datos del cliente
y los dos clientes excluidos no cambien. No desactiva triggers.

Primero paso una prueba reversible; despues se aplico la misma transaccion con
COMMIT y se verificaron los 14 clientes en una consulta independiente. Repetir el
runbook verificado con ROLLBACK tambien paso y no vuelve a actualizar campos ya
restaurados. El archivo conserva ROLLBACK por defecto.

No se modificaron pedidos, documentos historicos, pagos, comisiones, fondo,
inventario, permisos ni esquema. Los valores fiscales no se copian al repositorio:
se conservan en los pedidos fuente. Publicar este respaldo no ejecuta la reparacion.

## Perfiles multiples: propuesta, aun no implementada

La pregunta adicional del usuario plantea guardar al menos dos opciones por
cliente. Se propone permitir dos o mas perfiles con alias, razon social/nombre,
RIF/documento, direccion y telefono, con una opcion principal. Los datos de factura
y nota de entrega se eligen expresamente por pedido, sin activar IVA por tener
un perfil guardado. Guardar como nueva opcion debe distinguirse de modificar una.

Cada pedido conserva su snapshot; editar perfiles futuros no cambia documentos
anteriores. Las variantes de 2117 y 3718 no se convierten automaticamente en
empresas: primero hay que confirmar cuales son entidades distintas y cuales
son correcciones. Este trabajo no agrego tablas, selectores ni una funcionalidad
de multiples empresas.
