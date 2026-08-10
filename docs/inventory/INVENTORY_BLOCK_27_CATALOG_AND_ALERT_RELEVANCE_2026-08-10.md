# Bloque 27 — catálogo actual y relevancia de alertas

Fecha: 2026-08-10  
Estado: implementado y aplicado en producción.

## Regla canónica

Un ítem con saldo cero no abre por sí solo una alerta de agotado cuando:

- su única evidencia es el conteo de apertura; o
- su objetivo configurado es cero porque se fabrica bajo demanda.

La alerta vuelve a ser elegible automáticamente después de una entrada, venta,
producción, devolución o ajuste real. Los saldos negativos siempre son
accionables. Los productos con existencia positiva baja mantienen sus alertas
normales.

Esta distinción evita confundir una referencia disponible en el catálogo con un
producto que el negocio está procurando actualmente. No se agregó ninguna tabla
ni columna: se reutilizan movimientos, saldos, objetivos y políticas existentes.

## Efecto productivo verificado

El primer refresco posterior a la migración resolvió automáticamente cinco
alertas de apertura sin operación:

- Tequeños Regulares Pre-Fritos (bajo demanda, objetivo cero);
- Frescolita 2 Lts (disponibilidad y procura);
- Jugo del Valle 1,5 Lts (disponibilidad y procura).

Las alertas de ítems que sí tuvieron movimientos permanecieron activas según su
umbral. La regla no cambia saldos y no bloquea órdenes.

## Lectura simplificada

La portada de Inventario separa:

- nivel bajo con existencia positiva;
- ítems sin mínimo configurado;
- saldos negativos.

El catálogo incorpora filtros para esos tres estados. Administración puede abrir
directamente el configurador desde `Pendientes de mínimo`; no se inventaron
valores para los 12 ítems que todavía necesitan una decisión operativa.

## Verificación

- `inventory_refresh_alerts_core_v1`: 55 señales detectadas/actualizadas y 5
  resueltas automáticamente en el primer refresco.
- `npm run build`: correcto.
- El helper de relevancia vive en `app_private`, usa `search_path` vacío y no es
  ejecutable por `anon` ni `authenticated`.

## Migración

- `20260810222215_inventory_catalog_alert_relevance_v1.sql`

