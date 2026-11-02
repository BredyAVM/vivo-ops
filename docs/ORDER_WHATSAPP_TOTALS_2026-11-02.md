# Totales del resumen de pedido para WhatsApp

El formato compartido de `src/lib/orders/whatsapp-summary.ts` presenta este bloque
en resumenes de pedidos y presupuestos del compositor:

```text
TOTAL USD: $45.00
TOTAL BS: Bs 40.031,10
Tasa del BCV ($): 889,58 Bs/USD
Calculado: 01/11/2026
```

Los titulos mantienen los asteriscos de negrita de WhatsApp. La fecha usa
America/Caracas y no incluye hora. La tasa de este bloque se muestra con dos
decimales; no se redondean ni recalculan los valores originales para obtener
los totales. Los montos y la tasa siguen proviniendo del llamador certificado.
El nombre solicitado de la tasa no implica consultar una tasa actual diferente.

Consumidores: detalle compartido de Master (dashboard, operaciones y espacio
de ordenes de Administracion), detalle del Asesor y nuevo pedido del Asesor.
No se modifica MasterDashboardClient.tsx ni se agregan llamadas al servidor.

La cotizacion independiente de saldo para pago mantiene su semantica de saldo,
politica de cobranza, precision de tasa y hora de consulta. Tampoco se alteran
propuestas historicas ya guardadas como texto ni se migran datos.

Pruebas: bloque exacto para pedido/presupuesto, fecha de Caracas al cruzar
medianoche UTC, formato Bs, precision original intacta, cantidades/precios,
ordenacion de productos y circuito separado de cotizacion de pago.
