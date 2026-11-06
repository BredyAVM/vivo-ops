# Doble envio de pedidos del Asesor

## Evidencia de Ramon Viviescas

Tres pares conservan igual cliente, productos, notas, importe y horario:

| Fecha Caracas | Orden cancelada | Orden conservada | Separacion |
| --- | --- | --- | --- |
| 09/09/2026 | 2492 | 2493 | 0.097 segundos |
| 19/08/2026 | 1949 | 1950 | 4.877 segundos |
| 18/08/2026 | 1931 | 1932 | 0.108 segundos |

El historial confirma los motivos: cargado 2 veces, cargado doble y el pedido fue
cargado doble. Son anteriores a la creacion atomica incorporada el 13/09.
No tienen advisor_creation_idempotency_key.
Ampliar la busqueda de Ramon a 48 horas entre pedidos devolvio solamente esos
tres pares exactos.

Las ordenes 3841/3842 del 06/11 tienen mismo cliente, productos e importe, pero
entregas diferentes: 23/11 a las 16:00 y 30/11 a las 08:00. No se clasificaron
como duplicado exacto ni se modificaron.

La busqueda general de ordenes source=advisor desde 13/09 no encontro pares
exactos de cliente/creador/items/notas/importe/schedule creados dentro de 15 minutos.
Esto no prueba ausencia de duplicados fuera del criterio o de esa ventana.

## Proteccion existente verificada en produccion

- advisor_create_order_atomic_v1 conserva el UUID de solicitud y el hash del contenido.
- Hay bloqueo transaccional por usuario/UUID y un indice unico sobre usuario/UUID.
- Reenviar la misma solicitud devuelve la orden ya creada; usarla con informacion
  diferente se rechaza. Un borrador convertido tambien devuelve su orden existente.
- La creacion sigue siendo una transaccion: encabezado, items, eventos y conversion.

## Hueco preventivo corregido

El formulario revisaba el bloqueo al entrar, pero lo activaba despues de consultas
asincronas de disponibilidad/tasa. Dos toques podian alcanzar el preflight. Ademas,
tras obtener exito se borraban UUID/hora antes de completar router.push.

Ahora el bloqueo se adquiere sincronicamente antes del primer await. Un finally lo
libera incluso si falla una validacion. El UUID y la hora se conservan durante la
vida del formulario. Tras una creacion exitosa, otro toque abre el ID obtenido en
lugar de emitir otra creacion. No se cambia el circuito de edicion de ordenes.

## Verificacion y limites

29 pruebas: ejecucion del handler real transpilado con consultas demoradas,
doble toque, validacion sincronica, fallo de preflight, reintento y navegacion a la
orden ya creada; contrato de creacion atomica, detalles CRM y fecha ASAP.
Chequeo de tipos de la aplicacion correcto. ESLint sin errores, con una advertencia
preexistente de dependencias de useEffect. Falta QA de doble toque en telefono real.

No se cancelaron ordenes, no se crearon pedidos de prueba remotos ni se tocaron
pagos, comisiones, inventario o esquema. No hay polling ni consultas nuevas.

El bloqueo del formulario no comparte identidad entre dispositivos o pestañas,
y un recargo completo pierde las referencias de memoria. La base protege la misma
solicitud, no dos UUID independientes. Un detector transversal por parecido exige
advertencia/confirmacion y un identificador duradero de intencion; no debe
cancelar o fusionar automaticamente dos pedidos parecidos.
