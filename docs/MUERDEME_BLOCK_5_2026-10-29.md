# Estímulos por pedidos con hamburguesas

## Regla confirmada

Un pedido con hamburguesa genera un importe fijo de USD 0,30 para la primera compra válida del cliente y USD 0,20 para las siguientes. Se paga una sola vez por pedido, independientemente del número de hamburguesas, extras y combos. Administración puede cambiar ambos importes para pedidos nuevos desde **Negocio → Marcas y Muérdeme**.

Las papas no generan comisión. Tequeños, bebidas y demás productos VIVO mantienen sus reglas habituales en pedidos mixtos. Los porcentajes excepcionales sobre toda una orden tampoco se aplican a las hamburguesas ni a las papas. Este bloque no modifica metas, campañas ni criterios generales de venta.

### Condiciones de combos confirmadas el 30 de octubre

Cada combo puede sustituir el estímulo habitual por un importe fijo en USD. El campo vacío (o ausente en versiones anteriores) conserva la tarifa de primera compra/recurrencia; cero es una condición explícita sin estímulo por ese combo. Entre los combos y hamburguesas vendidos en el mismo pedido se usa el **mayor importe aplicable una sola vez**, sin sumar candidatos ni multiplicar por hamburguesas, extras, componentes o repeticiones del combo. Una hamburguesa suelta aporta como candidato la tarifa habitual; los componentes incluidos de un combo no aportan candidatos separados.

La bebida incluida está cubierta por la condición del combo y no añade automáticamente un 5%. Una bebida VIVO vendida aparte conserva su porcentaje habitual, igual que las demás partidas VIVO independientes. Por ejemplo: tequeños con comisión de USD 8, una bebida independiente de USD 2 al 5% (USD 0,10), y combos con condiciones de USD 0,20 y USD 0,80 generan USD 8,90 en total, no USD 9,10 ni una multiplicación por el precio de los combos.

La migración `20261030140956_muerdeme_combo_fixed_incentive_v1.sql` amplía la validación del catálogo y resuelve el importe usando las versiones de menú incluidas en los certificados del pedido. No acepta un monto enviado libremente por el asesor, no consulta la tarifa actual del combo para alterar una orden anterior y no cambia precios, inventario, porcentajes VIVO ni liquidaciones pagadas. El desglose identifica el nombre y la versión del combo cuando su condición resulta elegida. El catálogo sigue dentro de su circuito de preparación y no se habilitan ventas.

La primera compra se evalúa dentro de las compras válidas de hamburguesa Muérdeme, sin usar el historial VIVO como primera compra Muérdeme. Requiere entrega, total comercial positivo y cobranza confirmada sin pendiente de un centavo o más. Un pedido anterior por el canal directo cuenta como compra del cliente, pero no otorga el estímulo a un asesor por pertenecer a su cartera.

## Gestor y condiciones guardadas

El gestor de este estímulo es el asesor que creó la orden por el canal asesor. Se verifica su rol y su habilitación para recibir comisiones. No se utiliza como sustituto al propietario del cliente, ni se paga a un administrador o al teléfono directo por crear una orden atribuida a una cartera. Las comisiones VIVO siguen utilizando su atribución actual.

Al incorporar la primera hamburguesa se guarda una revisión de la política del pedido. Cambiar los importes, añadir otra hamburguesa, sustituir renglones o guardar nuevamente no reemplaza esa revisión ni multiplica el estímulo. Retirar todas las hamburguesas hace que no sea elegible. Los estados cancelados o sin cobranza completa tampoco lo son.

Los importes se suman a la comisión bruta de la liquidación como concepto identificado; el cálculo de deducibles, deuda, retención y abonos sigue utilizando el circuito existente. El desglose de administración y asesor muestra el número corto de pedido, primera compra o recurrencia, importe USD y versión aplicada, con el detalle plegado.

## Ciclos y pagos

El cálculo explícito del período consulta hasta 500 pedidos Muérdeme sin liquidar de los asesores seleccionados. Incluye entregas anteriores que ya estén cobradas al calcular el ciclo y no estén relacionadas con otra liquidación. No carga un histórico de estímulos al abrir la dashboard.

Una relación única por pedido impide cobrar el mismo estímulo en períodos superpuestos. Recalcular un preliminar sustituye sus relaciones de forma atómica; no acumula otro pago. Confirmar o pagar exige que el desglose siga correspondiendo a órdenes entregadas y cobradas. Los pagos parciales también verifican esta condición antes del egreso, bajo los bloqueos de órdenes existentes, incluyendo pedidos de ciclos anteriores presentes en el desglose.

Las liquidaciones cerradas conservan su detalle; antes de cambiarlo deben reabrirse. Las pagadas no se recalculan ni pierden sus referencias por una cancelación posterior. Una rectificación económica después de pagar requiere el ajuste administrativo correspondiente, conservando el historial.

## Base de datos y preservación

La migración `20261029172623_muerdeme_order_incentives_v1.sql` añade condiciones por orden y relaciones de liquidación en tablas privadas con RLS y controles de escritura. Las funciones nuevas son invocadoras y tienen `search_path` vacío. La configuración previa de importes permite ahora guardar revisiones futuras también cuando la marca esté operativa, sin alterar las revisiones anteriores.

El escritor de pagos existente conserva sus validaciones y operaciones. Su bloqueo de órdenes incorpora los pedidos del desglose especial y añade una comprobación solo cuando la liquidación contiene este concepto. Los pagos VIVO sin estímulo omiten esa comprobación. No se crean egresos automáticos, no se activan ventas y no se recalculan liquidaciones existentes al instalar.

## Validación

- Comparación del generador real de comisiones con su versión anterior en 15 escenarios VIVO de porcentajes, exclusiones, descuentos y pedidos sin renglones: mismos resultados.
- Pedidos mixtos: la hamburguesa y las papas no heredan porcentajes normales, porcentajes por ítem ni porcentajes de toda la orden. Una o cien hamburguesas conservan un solo importe por pedido.
- PostgreSQL aislado: primera compra y recurrencia, papas sin estímulo, canal directo, no entregadas, no cobradas, versiones futuras, reintentos, relaciones entre períodos, protección de cerrados/pagados y cobro tardío en otro ciclo.
- Ejecución del escritor de pagos real con dependencias mínimas: pagos parciales y finales VIVO equivalentes antes/después; reintento sin otro egreso; pago del estímulo rechazado cuando se anula el cobro del cliente, sin registrar movimientos.
- Desglose compacto con importes USD explícitos, números cortos y detalle plegado. Los snapshots históricos VIVO no muestran una sección de estímulos inexistentes.
- Vista real del componente revisada con datos ficticios en escritorio y en 390 px: sin desbordamiento lateral. No se guardó una liquidación ni un pago de demostración en producción.
- Tras instalar, las huellas de productos VIVO, liquidaciones pagadas y funciones financieras públicas coincidieron con las anteriores. La política conserva USD 0,30 / USD 0,20; las tablas nuevas no contienen derechos ni relaciones reales.
- Los avisos previos del asesor de seguridad permanecen y aparecen dos avisos potenciales de descubrimiento GraphQL por tablas privadas nuevas, protegidas por RLS. No se añadieron funciones privilegiadas ni acceso anónimo.

## Apertura pendiente

Muérdeme continúa en preparación. No se han cargado productos, tarifas comerciales, recetas ni ventas reales de prueba. El bloque de bebidas compartidas del 30 de octubre conecta los componentes de los combos con el catálogo e inventario VIVO existentes, sin otra comisión por la bebida incluida. Queda pendiente cargar el menú aprobado, habilitar el canal directo con sus permisos y completar las comprobaciones generales de apertura.
