# Bloque 14 — Reportes y proyección canónica

Fecha: 2026-08-08

Estado: aplicado en Supabase y disponible dentro del Centro de Inventario.

## Resultado

El Centro de Inventario incorpora `/app/inventory/reports` con cuatro lecturas:

- existencias y disponibilidad protegida;
- proyección de compromisos, entradas y producciones para los próximos 10 días;
- historial de conteos y diferencias;
- kardex canónico paginado por ítem.

Este bloque no modifica Master, Counter, Cocina, Asesor ni Finanzas. Tampoco
conecta todavía el inventario con el envío de órdenes y, por tanto, no crea
bloqueos operativos.

## Estructura reutilizada

No se crearon tablas ni columnas. Los reportes consolidan las estructuras que
ya son el centro de verdad:

- `inventory_items`;
- `inventory_movements`;
- `inventory_planned_flows`;
- `inventory_counts` e `inventory_count_lines`;
- `inventory_alerts`;
- `product_inventory_links`, `product_components` y `products`.

La consulta calcula los productos afectados de forma recursiva. Por eso un ítem
puede explicar tanto el producto directo como los combos o packs que dependen de
él.

## Regla de apertura

Los saldos heredados no se presentan como stock físico canónico. Mientras un
ítem no tenga un conteo de apertura aceptado, el reporte muestra `Pendiente de
apertura` y deja nulas sus cantidades de stock y disponibilidad.

Esta regla evita convertir los movimientos históricos sin operación canónica en
existencias actuales y evita mostrar como reales los saldos negativos heredados.

## Proyección a 10 días

El reporte separa, por ítem:

- stock físico contado;
- cantidad comprometida por órdenes confirmadas;
- disponibilidad sin depender de una reposición futura;
- entradas o producciones esperadas;
- disponibilidad proyectada al final del horizonte;
- compromisos posteriores al horizonte, sin descontarlos del número operativo
  de los próximos 10 días.

Una proyección que depende de mercancía o producción futura se identifica
explícitamente. Esa dependencia no se confunde con stock físico disponible hoy.

## Kardex

El kardex incluye únicamente movimientos con `operation_id`, es decir,
movimientos creados por el motor canónico. Los movimientos heredados quedan
fuera para no mezclar trazabilidad antigua con operaciones verificables.

La paginación usa cursor compuesto por fecha e identificador. No usa desplazamiento
por número de filas, por lo que una página nueva no cambia de posición si se
registran movimientos mientras se consulta el historial.

## Permisos

- Administración y Master pueden abrir los reportes y el kardex.
- Asesor no puede acceder al centro administrativo.
- Los clientes no leen directamente las tablas del motor para formar el reporte;
  consumen RPCs con validación explícita de usuario y rol.

## Decisión para Counter y Asesor

La integración futura será `fecha primero`:

1. el usuario selecciona la fecha y hora objetivo de la entrega;
2. Counter o Asesor solicita la evaluación de inventario para ese `target_at`;
3. después se presenta el catálogo con mensajes informativos de disponibilidad;
4. la orden puede enviarse aunque exista riesgo; Master conserva la aprobación
   final.

El contrato de lectura para esos módulos deberá informar, como mínimo:

- instante evaluado;
- disponible sin afectar pedidos confirmados;
- si la disponibilidad depende de reposición o producción esperada;
- próxima hora conocida de disponibilidad;
- nivel y mensaje de advertencia;
- razones que Master debe revisar.

Este contrato será un adaptador pequeño. No obligará a Counter o Asesor a cargar
todo el Centro de Inventario y nunca decidirá por sí solo si una orden puede
crearse.

## Verificación

- migración aplicada sin nuevas tablas ni columnas;
- consulta completa ejecutada en aproximadamente 25 ms sobre los datos actuales;
- saldos heredados ocultos hasta la apertura;
- apertura, entrada, avería y kardex verificados dentro de una transacción con
  `ROLLBACK`;
- paginación del kardex verificada con cursor;
- Master autorizado y Asesor rechazado;
- TypeScript y ESLint sin errores.

