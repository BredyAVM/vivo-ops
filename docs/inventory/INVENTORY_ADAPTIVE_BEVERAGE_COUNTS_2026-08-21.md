# Conteo adaptativo de bebidas

Fecha canónica: 2026-08-21.

## Regla operativa

- El conteo por turno continúa siendo flexible y sin numeración de turnos.
- Crudos, prefritos y salsas configurados `per_shift` aparecen siempre.
- Bebidas aparecen por ciclo o por excepción: recepción posterior al último conteo, diferencia previa o cercanía al mínimo.
- Las bebidas en cero estable no ensucian la lista; vuelven a aparecer cuando entra mercancía.
- El primer conteo permanece ciego.
- Si existe una diferencia, el mismo envío abre atómicamente una segunda verificación ciega con solo los ítems distintos.
- Ninguna de estas reglas bloquea órdenes, entregas ni ventas.

## Recorridos físicos

- `beverage_pepsi`: cava Pepsi y su reserva; incluye Pepsi, Malta, Yukery, Yukipack y Lipton.
- `beverage_coca_cola`: cava Coca-Cola y su reserva; incluye Coca-Cola y sabores relacionados.
- `beverage_reserve`: ubicación genérica para una bebida nueva todavía no clasificada.

La ubicación es una guía para contar. No divide el saldo: cada bebida conserva una sola existencia canónica.

## Configuración inicial

- Diario: 7 bebidas con mayor salida auditada.
- Semanal adaptable: 14 bebidas restantes.
- Administración puede cambiar frecuencia, responsable, mínimo y ruta desde el perfil del ítem.
- Las bebidas nuevas reciben una ruta inicial por marca conocida o, en su defecto, la reserva genérica.

## Superficies

- Cocina: lista automática por familia y recorrido físico.
- Máster/Administración: detalle de conteo agrupado por familia y cava, con sistema, contado, diferencia y estado.
- Administración: editor del ítem con ruta física editable.

## Implementación

- Migración remota: `20260821193817_inventory_adaptive_beverage_shift_counts_v1`.
- No se creó ninguna tabla nueva.
- Se añadió únicamente `inventory_items.primary_count_location_code` y se reutilizaron conteos, líneas, movimientos, frecuencias y roles existentes.
