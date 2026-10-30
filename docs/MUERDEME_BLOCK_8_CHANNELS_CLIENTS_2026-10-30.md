# Bloque 8 Canales y clasificación comercial de clientes

VIVO Fritos y Muérdeme comparten un negocio, una ficha por cliente y los operadores de Counter. El canal describe cada pedido; no depende de la marca, del cajero ni de pickup/delivery. Este bloque incorpora esa identificación y la categoría Directo sin reclasificar datos existentes ni abrir las ventas de Muérdeme.

## Reglas acordadas

| Canal del pedido | Significado |
| --- | --- |
| Presencial | Atención directa del cliente en el local. |
| WhatsApp | Pedido recibido en el número de atención del negocio. |
| Asesor | Venta gestionada por asesor, Master o Administración actuando como vendedor. El WhatsApp personal de un asesor continúa en este canal. |

Los cajeros comparten el módulo y pueden elegir Presencial o WhatsApp en cada venta. El usuario autenticado identifica al operador. La marca se obtiene de las partidas; una orden mixta sigue siendo una sola orden.

| Tipo de cliente | Significado |
| --- | --- |
| Propio del asesor (`own`) | Captado por el asesor. |
| Asignado por el negocio (`assigned`) | Derivado por el negocio a un asesor para seguimiento. |
| Directo del negocio (`direct`) | Atendido directamente sin derivación a asesor. |

`legacy`/Antiguo y los valores históricos sin clasificar se conservan. Los clientes nuevos de Counter son Directos; reutilizar una ficha existente mantiene su tipo y asesor, incluso si cambia el canal de la compra. La asignación formal de un Directo a un asesor lo convierte en Asignado y conserva actor, fecha y valores anterior/nuevo.

En ventas presenciales de VIVO que corresponden al seguimiento actual se mantiene la derivación comercial. Hamburguesas y pedidos mixtos no se derivan por defecto. La excepción por volumen importante de VIVO queda manual, sin inventar umbrales. Una compra no retira el asesor de un cliente existente. Tampoco adjudica automáticamente un Directo por tener una orden atribuida a un asesor.

No se pregunta por Instagram, recomendación, campañas, punto de contacto o una sede nueva. La procedencia publicitaria no se deduce del canal observado. La gestión de múltiples locales permanece fuera de este bloque.

## Implementación

- Migración `20261030175530_commercial_channels_clients_v1.sql`.
- `orders.sales_channel` es independiente del enum técnico `orders.source`. Admite `in_person`, `whatsapp`, `advisor`; el historial permanece NULL. Las nuevas órdenes de asesor/Master usan Asesor por defecto y Counter usa Presencial cuando un cliente antiguo del software no envía selección.
- El canal se guarda al crear y es inmutable en las ediciones ordinarias. No modifica la aprobación, los estados, el pago, la tasa, las comisiones ni el inventario. La venta inmediata de Counter conserva envío a cocina; la venta futura conserva la agenda actual.
- El comando atómico existente de Counter conserva reintentos, cliente único por teléfono, guardia de suspensión comercial y precios. El parche modifica únicamente el tipo para altas nuevas, la validación de canal y su columna de inserción.
- Se evita la adjudicación automática de Directos en el rescate de carteras huérfanas. Los clientes anteriores conservan el mecanismo VIVO existente. Master y Administración pueden derivar un Directo mediante la edición existente de cliente.
- Historial privado `app_private.client_commercial_type_history_v1`: escritura exclusiva mediante disparador; lectura limitada a Master/Administración activos. No se amplían permisos de venta, banca ni de clientes.
- Counter, el editor compartido de Admin/Master, el editor del asesor y el administrador antiguo reconocen Directo. La configuración administrativa utiliza etiquetas explícitas y conserva Antiguo y sin clasificar.
- Análisis comercial permite filtrar por canal, por período y bajo consulta explícita. El historial sin canal permanece incluido en Todos; no se lo presenta como WhatsApp ni Presencial. El CSV incorpora el canal observado.
- Directos no se suman como clientes nuevos propios/asignados en las métricas de asesores. No se modifican las funciones financieras ni los cierres pagados.

## Verificación

- 143 pruebas de marcas, incluidos los nuevos casos de clasificación y PostgreSQL.
- 97 pruebas de comisiones, 32 de órdenes y 19 de configuración.
- TypeScript, revisión de los componentes afectados y compilación de producción.
- PostgreSQL aislado ejecuta el comando Counter real con los tipos de columna inspeccionados. Compara importes mixtos USD/VES e IVA antes/después; verifica clientes existentes, ambos cajeros y canales, duplicados, reintentos, rollback tardío, agenda, derivación manual, preservación del rescate VIVO y rechazos por permisos.
- El esquema de prueba no contiene registros reales. La simulación usa un auxiliar neutro de notas; las configuraciones y existencias se comprueban en las suites de marcas/inventario independientes. PGlite no prueba contención entre conexiones simultáneas.

## Secuencia siguiente

El bloque 9 conecta el configurador de hamburguesas y combos con la venta rápida de Counter. Este bloque 8 identifica los canales y clientes; no declara habilitada esa captura ni activa un menú comercial de Muérdeme. Después permanecen la administración del catálogo en operación, el menú y recetas reales, excepciones operativas, alcance de metas VIVO, indicadores por marca y la apertura controlada.
