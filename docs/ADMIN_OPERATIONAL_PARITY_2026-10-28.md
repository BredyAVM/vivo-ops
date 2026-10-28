# Administración: revisión operativa del 28 de octubre de 2026

## Entrega

1. **Modificar evento** desde la ficha de la orden y desde Eventos → ficha →
   Modificar orden inicial. El editor se descarga y consulta solo al abrirlo.
   Permite total acordado o combitos × precio + stand − descuento. Todas las
   cantidades físicas son UND. Un solo producto ajusta sus piezas al cambiar
   combitos/piezas por combito; las composiciones variadas se editan por producto.
2. **Conversión atómica** del presupuesto inicial. Una fila de borrador bloqueada
   identifica el reintento: devuelve la misma orden. Cliente nuevo, pedido, partidas,
   composición, condiciones comerciales, vínculo y avisos se guardan juntos.
3. **Comisiones** mantiene el resumen y el motor compartido. El acceso principal
   «Calcular y pagar comisiones» abre la consulta operativa del período elegido;
   no calcula ni paga por abrirlo. Se distingue del resumen de cálculos guardados.
4. **Cierre de cuenta** añade egreso y traspaso para la cuenta seleccionada, con
   regreso al cierre de esa cuenta. Son accesos: no ejecutan movimientos.

## Reglas conservadas

- Edición y conversión exclusivamente administrativas, verificadas también en SQL.
  Las funciones usan SECURITY INVOKER, RLS y search_path vacío. Anónimo no ejecuta.
- Se conserva el identificador de la partida de evento, la moneda, la tasa guardada
  y la comisión acordada. Los ajustes administrativos de comisión mantienen su
  precedencia. No se recalculan cierres conformados/pagados ni se alteran pagos.
- El descuento del desglose ya está incluido en el precio negociado de la partida:
  el descuento de cabecera sigue en cero. No se duplica.
- Las piezas/preparación se cambian antes de empezar cocina (creada/en cola).
  Después se permite ajustar el precio conservando las piezas; el retorno a cola
  y las correcciones de inventario conservan su circuito operativo existente.
- Se ejecutan los triggers de precios, composición y compromisos habituales.
  Se verifica la composición resultante; un fallo no bloqueante de inventario se
  convierte en rechazo completo del guardado. La edición no mueve stock físico.
- Una versión desactualizada de la orden se rechaza. El presupuesto aceptado
  original permanece intacto; el antes/después se registra en ajustes y eventos.
- «Modificar orden» conserva fecha, entrega, notas y demás opciones generales.
  «Modificar evento» es un acceso adicional a composición y desglose comercial.
- Las ampliaciones siguen usando sus autorizaciones y órdenes propias.

## Matriz de las operaciones financieras habituales

| Operación del administrador anterior | Acceso administrativo actual | Verificación de esta revisión |
| --- | --- | --- |
| Ingreso/egreso de caja o cuenta | Finanzas → Cuentas y caja → Ingreso/Egreso | Código, pruebas de permisos/reintentos y apertura del egreso en producción |
| Retiro de efectivo durante cierre | Cierre → seleccionar cuenta → Registrar egreso | Acceso contextual añadido; conserva cuenta y retorno |
| Traspaso entre cuentas | Cuentas y caja → Traspaso; también desde cierre | Formulario abierto en producción, pruebas de ambas patas y reintentos |
| Saldo contado/observado y cierre | Cuentas y caja → Cerrar cuenta | Formulario y selección de caja en producción; pruebas de corte exacto, moneda y fallos |
| Anular un pago/movimiento | Cuenta → movimiento → Anular movimiento | Botón comprobado en producción sin ejecutarlo; comando compartido probado |
| Confirmar/rechazar pago de cliente | Finanzas → Pagos de clientes; ficha de orden → Pagos | Circuito existente; conserva revisión de tasa acordada y motivos |
| Ajustar precio/comisión de orden | Órdenes → ficha → Precios y comisiones | Motor existente conservado; pruebas de precedencia/roles |
| Cancelar orden | Órdenes → ficha → Cancelar | Circuito de cancelación existente, separado de anular un pago |
| Calcular, conformar y pagar comisiones | Finanzas → Comisiones → Calcular y pagar comisiones | Entrada aclarada; mismo módulo y período |
| Liquidar delivery con extras/deducibles | Finanzas → Delivery | Circuito existente por consulta y período; no modificado |
| Cambiar evento existente | Órdenes → Modificar evento; Eventos → ficha | Nuevo comando transaccional y editor bajo consulta |

La matriz confirma accesos y reutilización de comandos. No equivale a haber
ejecutado egresos, pagos, anulaciones o cierres reales para probarlos. Tampoco
autoriza retirar el administrador anterior: se conserva disponible.

## Validación

- Pruebas aisladas de PostgreSQL: conversión/reintento, revisión 60→35 combitos,
  piezas 300→175, USD 121,50, comisión 5%, identidad de partida, rechazo por versión,
  roles, operaciones tardías, rollback ante fallo final, cliente y tasa VES.
- Regresiones de cuentas, cierres, traspasos, anulación, navegación de órdenes y
  comisiones. Compilación estricta de producción y revisión ESLint.
- Ensayos en Supabase con ROLLBACK y rol authenticated: revisión de #3586 y
  conversión de copia temporal del presupuesto, reintento único, triggers reales
  y comprobación de restricciones diferidas. No se conservan los registros de
  ensayo; las secuencias pueden dejar números sin usar al revertir.
- Un test global previo (`admin-shell-boundary`) prohíbe cualquier consulta directa
  en todo el árbol administrativo; ya falla por Premios/Evaluación presentes en
  HEAD, fuera de estos cambios. No se debilitó ni se ocultó esa regla. Las pruebas
  específicas de límites financieros y de las operaciones se mantienen separadas.

## Alcance posterior

Compras/proveedores/cuentas por pagar y materia prima continúan siendo el próximo
bloque nuevo. Viajes compartidos entre ampliaciones y catálogo configurable de
ampliaciones conservan sus límites documentados; esta entrega no los implementa.
