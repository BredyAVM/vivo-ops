# Módulo de jugadas CRM — definición funcional

## Principio rector

Una jugada es una intervención comercial planificada. El administrador define a quién aplica, qué estímulo ofrece, cuánto cuesta y cómo se medirá. El asesor recibe una lista compacta y ejecuta el contacto. El sistema conserva la evidencia y calcula los resultados.

## Dos experiencias conectadas

### Administrador

1. Parte de una jugada anterior o crea una nueva.
2. Define objetivo, vigencia, mensaje, condiciones comerciales y beneficios.
3. Prueba la definición y revisa clientes, asesores, cierres, facturación, conflictos y presupuesto.
4. Retira casos manualmente si hace falta.
5. Confirma un snapshot inalterable.
6. Comparte la jugada con los asesores.
7. Supervisa ejecución, respuesta, compras, canjes e inversión.
8. Evalúa resultado directo e influencia posterior.

### Asesor

1. Solo ve jugadas confirmadas y compartidas.
2. Trabaja una fila compacta por cliente.
3. Abre la ficha, copia el mensaje y abre WhatsApp.
4. Registra únicamente lo que el sistema no puede saber: jugada lanzada, respondió o no respondió y una nota opcional.
5. El sistema detecta compras, canjes, vencimientos y cambios de frecuencia.

## Reglas invariables

- Una jugada en borrador nunca es visible para asesores.
- La lista confirmada es un snapshot y no cambia durante la jugada.
- La cartera viva del asesor sí se actualiza con cada compra.
- Por defecto, un cliente no puede estar en dos jugadas que se solapen.
- Las excepciones de convivencia se autorizan entre jugadas concretas.
- Por defecto, una orden solo consume un beneficio económico de jugada.
- Una compra se atribuye directamente cuando el beneficio está dentro del pedido.
- Una mejora posterior se considera influencia cuando hubo contacto y respuesta, aunque no hubiera canje.
- Los datos crudos y eventos se conservan; las métricas derivadas pueden recalcularse con otra ventana.

## Beneficio como crédito controlado

- El beneficio base se toma del catálogo normal, incluyendo productos o servicios.
- Si la compra cumple la condición, el cliente recibe el valor congelado de la jugada.
- Si no cumple, el producto sigue disponible a su precio normal; no se bloquea la orden.
- El cliente puede ampliar a un producto permitido y paga solo la diferencia.
- Esa diferencia forma parte de la facturación y es comisionable según la regla normal del producto final.
- El beneficio y la ampliación no ayudan a alcanzar su propia compra mínima.
- La orden y el inventario registran únicamente el producto final, nunca base más ampliación.
- Los Gambits históricos permanecen para auditoría, pero no deben duplicar productos normales en jugadas nuevas.

## Moneda y fotografía financiera

- El catálogo conserva la moneda de origen del producto.
- Al confirmar la jugada se congela la tasa, el precio de origen y la equivalencia USD.
- Al crear la orden se usa la tasa congelada de la orden para mostrar y cobrar en bolívares.
- El aporte de empresa y el cargo del asesor quedan congelados por jugada y luego por canje.

## Mensaje y seguimiento

- La ficha incluye orientación interna y un mensaje listo para copiar.
- Variables iniciales: `{nombre}`, `{asesor}`, `{beneficio}` y `{vigencia}`.
- WhatsApp se abre con el mensaje preparado; el envío sigue siendo manual.
- Estados manuales mínimos: `Pendiente`, `Jugada lanzada`, `Respondió`, `No respondió`.
- Compra, canje, vencimiento y repetición se calculan automáticamente.

## Evaluación

Embudo base: asignados → lanzados → respondieron → compraron → canjearon → repitieron.

La evaluación debe mostrar:

- conteos y porcentajes generales y por asesor;
- inversión real de empresa y asesores;
- ventas y diferencias pagadas por clientes;
- resultado directo por canje;
- influencia a 30, 60 y 90 días;
- frecuencia anterior frente a frecuencia posterior;
- clientes sin respuesta repetida, sin convertir una sola falta de respuesta en una etiqueta permanente.

## Entregas

1. Fundamento operativo: copia, mensaje, convivencia y congelación de precios.
2. Beneficios universales: productos, servicios, créditos y ampliaciones.
3. Diseñador y confirmación completa del administrador.
4. Cola compacta y seguimiento mínimo del asesor.
5. Aplicación segura en pedidos, comisiones e inventario.
6. Supervisión, evaluación y memoria CRM.
