# Copia actualizada de pedidos para WhatsApp

## Hallazgos

El detalle del Asesor copiaba un texto serializado al cargar la pagina. Master y
Administracion construian el texto desde el objeto de la pantalla/drawer. Ninguno
reconsultaba en el clic. Podian quedar antiguos pago, productos, totales, datos del
cliente, asesor, entrega, cambio, notas y documentos. El Asesor ademas reemplazaba
el nombre con un cache local, y las marcas @prep/@event podian filtrarse al texto.

## Solucion

Los tres botones de copia de ordenes persistidas usan
`copyLiveOrderWhatsApp(orderId)`: una accion autenticada y una consulta de snapshot,
sin cache, polling ni revalidacion completa. La consulta verifica acceso y lee una
fotografia coherente de encabezado, lineas, cliente, asesor y estado financiero.

Se usa `get_order_financial_state`, sin sumar reportes como si fueran pagos ni
volver a calcular deuda. Copiar no modifica pagos, fondo, orden, inventario, tasa
ni cotizaciones de pago. Por validar no significa pagado. Se reconocen saldo
parcial y aplicaciones del fondo; si la forma prevista seguia pendiente tras un
pago confirmado, el texto informa Pago registrado/Fondo del cliente sin inventar
un metodo bancario.

El resumen conserva los montos y tasa del pedido, el bloque compacto de totales
y las notas humanas. Filtra marcas de componentes solamente al mostrar. En
iPhone se reserva el portapapeles dentro del toque antes de esperar la red.
Los errores no copian un respaldo viejo y se comunican en espanol.

## Permisos

Migracion aplicada: `20261106143339_order_whatsapp_live_snapshot.sql`.
La RPC publica es SECURITY INVOKER. El lector privado es un acceso acotado
SECURITY DEFINER que valida auth.uid y roles de base: Master/Admin o asesor
atribuido a esa orden. No utiliza metadatos editables para autorizar. El nombre
de metadatos solo sirve para presentacion. Anonymous y asesores ajenos se rechazan.
No se conceden lecturas generales sobre tablas financieras internas.

La lectura atomica privada permite utilizar el circuito financiero interno sin
abrir delivery_settlements a authenticated, cuyo permiso directo ya faltaba en la
auditoria anterior. No se alteran los permisos ni las funciones financieras previas.

## Verificacion

- 47 pruebas de formato, transiciones de pago, datos frescos, integracion de
  botones y portapapeles asincrono (simulacion de Safari y alternativa writeText).
- Prueba SQL reversible y posterior a instalar: pago confirmado, fondo aplicado,
  acceso propio, rechazo ajeno y rechazo sin sesion. Sin registrar pagos de prueba.
- Chequeo de tipos de la aplicacion y ESLint sin errores; existe un warning previo
  de variable no utilizada en OrdersWorkspaceClient.
- Sin hallazgos nuevos del asesor de seguridad para las dos funciones agregadas.
  El proyecto conserva advertencias de seguridad previas, ajenas a este cambio.
- Falta validar el recorrido real del portapapeles en iPhone/Vercel. No se levanto
  servidor local ni se alteraron datos de negocio.

## Limites

Presupuestos aun no creados siguen copiando el formulario actual; no tienen pago
confirmado. Las propuestas antiguas guardadas como texto no se reescriben. La
cotizacion independiente de pago conserva su propio circuito de certificados.
Una modificacion no guardada no forma parte de la orden persistida exportada.
