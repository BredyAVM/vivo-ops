# Bloque 9 · Muérdeme en la venta rápida de Counter

Counter reutiliza el configurador de Muérdeme que ya comparten Asesor y Administración. Una orden admite productos VIVO, hamburguesas y combos; cada hamburguesa o combo conserva una partida individual y su propia configuración. No se duplica catálogo, cocina, cobro ni inventario.

## Operación

- En `Counter → Venta rápida → Muérdeme · menú`, la consulta es explícita. Abrir la venta no consulta automáticamente el menú ni sus recetas.
- La ventana permite elegir presentación, retirar ingredientes autorizados, añadir extras y configurar cada hamburguesa de un combo. Precio y suplementos nacen en USD.
- Cada configuración entra con cantidad uno. Dos hamburguesas distintas del mismo producto no se fusionan; `Configurar` reabre únicamente la partida elegida.
- El carrito muestra el total en USD y su equivalente en Bs. La composición larga queda en `Ver composición`.
- Se mantienen Presencial/WhatsApp, cliente único, modalidad pickup/delivery, venta inmediata o agenda y el motor de pagos existente.
- Counter conserva su atribución directa sin adjudicar un estímulo a un asesor por pertenencia del cliente a una cartera. Las ventas gestionadas por asesores mantienen el esquema del bloque 5/6.

## Guardado e inventario

La migración `20261102143805_counter_muerdeme_configured_sales_v1.sql` amplía el lector de menú a Counter activo. No le concede la administración del catálogo, recetas, cuentas o comisiones. El nuevo auxiliar privado no es ejecutable por los roles de aplicación.

El comando atómico existente valida cotización, revisiones, producto, cantidad y preparación física antes de crear el cliente. Reconstruye el precio y las notas desde la cotización aprobada en base de datos. Una revisión vencida pide volver a consultar; un precio enviado por el navegador no puede sustituir el precio autorizado. Los productos adaptadores internos permanecen inactivos y solo son aceptados junto con su configuración válida.

La recuperación de un intento ya terminado ocurre antes de esta validación: el mismo intento conserva su resultado aunque después se cierre el menú. Una solicitud distinta no puede reutilizar su identificador.

Los certificados, diagnóstico de cocina y libro de existencias son los existentes. La bebida de un combo referencia el producto VIVO compartido; se acumula con las bebidas vendidas aparte y se descuenta una sola vez al ejecutar la salida correspondiente. También conserva la suspensión comercial del producto VIVO.

La función compartida de precios recibe un único cambio condicionado a las partidas Muérdeme de Counter: conserva su precio certificado en lugar del cero provisional del adaptador. La rama VIVO, tasas, pagos y reglas de comisión permanecen iguales.

## Verificación

- 160 pruebas de marcas, incluidas pruebas de interfaz y del comando real de Counter en PostgreSQL aislado.
- 100 pruebas de comisiones y 18 regresiones de captura de pagos y preservación de precios.
- Comparación antes/después de una venta VIVO USD/VES con IVA, canal y atribución.
- Orden mixta: VIVO USD 14 + bebida separada USD 2,50 + combo configurado USD 15,75 + hamburguesa USD 5 = USD 37,25. A 860 Bs/USD conserva Bs 32.035. El combo y la bebida separada consumen dos botellas compartidas, sin duplicar productos.
- Configuraciones individuales, edición de una sola partida, datos adulterados, cantidad indebida, catálogo desactualizado, receta incompleta, bebida suspendida, usuarios sin acceso, rollback y reintento sin doble salida.
- TypeScript, revisión de los archivos afectados y compilación de producción. La simulación utiliza datos sintéticos; no registra ventas o pagos de prueba en producción. La prueba del libro físico ejecuta el escritor real sobre una orden marcada entregada por el operador de prueba, sin duplicar el proceso operativo de pickup completo ni simular contención entre conexiones.

La instalación en producción conservó las huellas de clientes y asesores, productos, reportes de pago, movimientos de dinero, cierres pagados y funciones financieras/inventario ajenas al parche. Se comprobó que la definición de precios solo recibió la condición prevista. El diagnóstico de seguridad no añadió hallazgos respecto a la línea base.

## Apertura y siguiente bloque

Muérdeme permanece en preparación: ventas desactivadas y ningún producto comercial real cargado. Esta conexión no activa su venta. Un carrito que incluya partidas de preparación no puede guardarse; retirarlas permite continuar con VIVO.

Sigue el **bloque 10: administración del catálogo durante la operación**, con cambios de menú y precios versionados que conserven lo ya vendido. Después se cargarán el menú y las recetas reales antes de la apertura controlada.
