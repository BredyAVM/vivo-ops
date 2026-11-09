# Datos guardados de factura y nota de entrega

## Causas verificadas

- La busqueda de clientes y la carga CRM consultaban los ocho campos correctos.
- El arranque desde initialClient o initialCrmContext seleccionaba el cliente,
  pero no ejecutaba applyClientProfile. El formulario quedaba vacio.
- Desmarcar factura o nota de entrega vaciaba sus campos en memoria.
- Guardar desde Asesor sin uno de esos documentos escribia null en la ficha del
  cliente. Las acciones compartidas de creacion/edicion de Master tambien podian
  borrar esos campos. No incluir un documento no es una solicitud de borrado.

La lectura agregada de produccion encontro 44 clientes con algun dato fiscal y
23 con algun dato de nota de entrega. No se leyeron ni modificaron datos personales
para publicar ejemplos; no se hizo recuperacion masiva de informacion anterior.

## Cambios

Los accesos desde ficha y jugada aplican el mismo perfil que la busqueda. Los
campos se conservan al ocultar/desmarcar y se limpian al retirar el cliente o
iniciar un cliente nuevo para no trasladar datos de otra persona.

clientDocumentProfilePatch es compartido por el Asesor y las acciones de
crear/editar de Master/Administracion. Solo incluye en UPDATE los grupos que
se solicitaron en el pedido. Al omitir un grupo conserva la ficha actual,
sin reescribir una copia antigua ni agregar consultas. Los campos explicitamente
editados de un documento habilitado siguen pudiendo actualizarse o vaciarse.

Los snapshots del pedido siguen condicionados por hasInvoice/hasDeliveryNote.
No se activa factura, IVA ni nota de entrega por detectar datos guardados. No se
sobrescriben los documentos explicitos de borradores ni de ordenes existentes.

## Verificacion

43 pruebas de precarga real de los ocho campos, cambios de cliente, callbacks de
checkboxes, politica de escritura no destructiva, normalizacion de telefonos,
creacion atomica, doble envio, fecha ASAP, composicion CRM y repeticion de pedidos.
La precarga y los callbacks se ejecutan transpilados del componente real; no solo
se comprueba la presencia de texto en el archivo.

No se alteraron SQL, tablas, permisos, pagos, clientes remotos ni historiales. La
correccion no reconstruye datos borrados antes de esta version: recuperarlos desde
pedidos anteriores requiere revisar el cliente concreto y confirmar su vigencia.
Falta validacion visual en telefono tras el despliegue.
