# Bloque 18: preparación final de la apertura de productos

## Alcance

Este bloque corrige la representación de Yukipack y separa el inventario
operativo de productos del inventario periódico de consumibles. No ejecuta una
apertura real, no escribe saldos físicos y no bloquea órdenes.

No se agregó ninguna tabla ni columna. Se reutilizaron `products`,
`product_components`, `inventory_items`, `inventory_item_presentations`,
`product_inventory_links` y las funciones existentes del corte.

## Yukipack por sabor

`YUKYPACK` permanece como el único producto comercial visible. Al agregarlo a
una orden se debe seleccionar exactamente un sabor por unidad:

| Opción | Existencia física confirmada | Presentación de entrada |
|---|---:|---|
| Manzana | 14 unidades | caja de 24 o unidades sueltas |
| Pera | 14 unidades | caja de 24 o unidades sueltas |
| Durazno | 22 unidades | caja de 24 o unidades sueltas |

Cada sabor tiene un ítem físico transaccional independiente. Los productos
auxiliares de sabor son componentes internos: Counter y Asesor pueden usarlos
al construir la selección, pero no aparecen como productos sueltos del catálogo.
El antiguo saldo genérico queda inactivo y no se traslada, para evitar sumar el
saldo legado negativo a las cantidades físicas nuevas.

## Cantidades físicas ya confirmadas

| Ítem | Apertura preparada |
|---|---:|
| Salsa Tártara 5 oz | 10 unidades |
| Salsa Tártara 2 oz | 10 unidades |
| Salsa Tártara 1 oz | 10 unidades |
| Aderezo Mostaza Miel 5 oz | 5 unidades |
| Aderezo Mostaza Miel 2 oz | 3 unidades |
| Tequeños Regulares Pre-Fritos | 0 servicios |

La regla del conteo de cierre queda documentada así: si un producto perteneciente
a ese conteo no aparece en la relación, su cantidad es cero. Esto no se extiende
a consumibles que pertenecen a otro programa de conteo.

## Cajas y otros conteos periódicos

`Cajas grandes` conserva `tracking_mode = periodic_count`, su frecuencia
quincenal y su punto de procura. No se descuenta por orden y no forma parte de la
apertura transaccional de productos. La referencia informal de “más de 150” no
se convierte en un saldo exacto; su saldo se establecerá cuando se haga el
conteo periódico correspondiente.

Por esta separación, una caja sin conteo exacto no puede impedir que el motor de
productos pase de legado a canónico. Tampoco desaparece del Centro de Inventario:
mantiene su historial, alertas y programación independientes.

## Seguridad operativa

- Asesor y Counter reciben información, pero inventario no impide enviar órdenes.
- Master conserva la decisión final de aprobar o rechazar.
- Esta preparación no activa recetas ni realiza la apertura.
- Las cantidades físicas anteriores solo se escribirán cuando se autorice y se
  ejecute el flujo formal de conteo, revisión y aceptación.

