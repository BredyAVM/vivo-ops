# Excepciones individuales de jugadas

## Alcance

Herramienta para órdenes guardadas que ya contienen un obsequio vinculado al CRM. No autoriza automáticamente la orden 2988 ni ninguna otra. No reabre ni prolonga una campaña completa y no incorpora obsequios por sí sola.

En Master/administrador, abrir el pedido y desplegar **Vigencia y excepciones de jugada**. También está disponible en **Modificar → Jugada del cliente**, junto a la autorización de mínimo de compra existente.

- **Fecha excepcional:** master o administrador eligen una fecha límite inclusive, en Venezuela, y explican el motivo. Autorizar no modifica la fecha del pedido ni lo entrega. Luego se puede reprogramar dentro del plazo autorizado.
- **Compra mínima:** se conserva la herramienta existente, exclusiva del administrador; permite un mínimo reducido o cero. Una excepción de fecha no exonera el mínimo.
- El asesor no autoriza excepciones. La validación del servidor funciona independientemente del navegador.

## Seguridad y operación

La autorización queda en un registro privado y en Eventos de la orden, con responsable, fecha y motivo. Está ligada al cliente, asesor, miembro CRM, vigencia original y las líneas exactas del beneficio. No cambia los costos congelados de empresa/asesor ni la ampliación comisionable. Un cambio de identidad del beneficio invalida la autorización; cambiar su composición sin cambiar producto/cantidad no la invalida.

Se revisan fecha programada y fecha actual. Pedidos nuevos/modificados fuera de vigencia se rechazan antes de avanzar a cocina. Los pedidos antiguos bloqueados pueden recibir autorización sin reconstruirlos. Notas, cancelación y retiro del obsequio siguen disponibles. La aplicación definitiva continúa ocurriendo al entregar; se mantienen las reservas y la prohibición de uso en otra orden.

Una autorización nueva puede reemplazar el plazo anterior para el mismo conjunto de obsequios; siempre conserva el historial. No puede habilitar una campaña pausada/cancelada, un cliente retirado o un beneficio usado en otra orden.

## Límite deliberado

No es una herramienta para añadir clientes fuera de lista ni para insertar por primera vez un beneficio de una campaña cerrada en una orden que no lo tenía. Esas son operaciones distintas. Para un pedido aún dentro de vigencia que se va a reprogramar, autorizar primero y después cambiar la fecha.

## Verificación

- `tests/crm/order-validity-db.mjs`: Postgres aislado con PGlite 0.5.8, sin credenciales remotas. Acepta `PGLITE_RUNTIME` como URL del módulo instalado o utiliza el directorio de pruebas habitual en outputs.
- Cubre permisos, duplicación de solicitudes, fecha fuera de plazo, estado cerrado/pausado/retirado, composición editable, mínimo independiente, entrega y costos, cancelación/retiro y no reutilización.
- TypeScript del proyecto y lint de los componentes nuevos.
- La migración no actualiza órdenes ni concede excepciones. Las sustituciones de funciones comprueban la versión esperada para no borrar validaciones desplegadas por otros cambios.

## Estado de publicación

Base de datos instalada con versión `20261001143104`; cero autorizaciones creadas por la implementación. La pantalla todavía no está publicada: el control de seguridad exigió autorización humana expresa para enviar el commit a `main` y activar producción. No se utilizó otra vía de publicación. Pendiente verificar visualmente el formulario publicado, sin conceder una excepción real como parte de las pruebas.

El asesor de seguridad de Supabase reporta dos condiciones deliberadas: [tabla privada con RLS sin políticas](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), que impide acceso directo, y RPC autenticadas SECURITY DEFINER que acceden al registro privado. Estas últimas comprueban identidad y rol/propiedad dentro de la función, revocan ejecución anónima y fijan search_path vacío. Ver [seguridad de funciones](https://supabase.com/docs/guides/database/functions). Las pruebas verifican que asesor/mostrador/anónimo no puedan autorizar.
