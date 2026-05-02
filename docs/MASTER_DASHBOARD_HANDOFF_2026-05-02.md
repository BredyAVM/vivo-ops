# Master Dashboard Handoff

Fecha: 2026-05-02

Este documento resume el estado real del dashboard master de `vivo-ops`, con foco en:

- arquitectura funcional ya trabajada
- archivos clave
- decisiones técnicas importantes
- zonas delicadas del sistema
- próximos pasos recomendados

La idea es que otro chat pueda leer esto y retomar sin depender del historial largo.

## 1. Estado general

El dashboard master ya no está en fase inicial. Se ha trabajado bastante en:

- flujo operativo de órdenes
- drawer de nueva orden
- detalle de la orden
- ruta / tiempos / alertas
- catálogo e inventario
- timeline / eventos por orden
- inbox operativo del master

El archivo principal más tocado es:

- `C:\Users\bredy\Desktop\vivo-suite\vivo-ops\src\app\app\master\dashboard\MasterDashboardClient.tsx`

Otros archivos relevantes:

- `C:\Users\bredy\Desktop\vivo-suite\vivo-ops\src\app\app\master\dashboard\page.tsx`
- `C:\Users\bredy\Desktop\vivo-suite\vivo-ops\src\app\app\master\dashboard\actions.ts`
- `C:\Users\bredy\Desktop\vivo-suite\vivo-ops\docs\order-events-v1.sql`

## 2. Criterio visual ya definido

El proyecto viene trabajando con estas reglas de UI:

- interfaz compacta
- poco scroll innecesario
- lenguaje simple en español
- enfoque operativo, no decorativo
- controles con alturas consistentes
- solo dirección / notas pueden usar cajas altas
- evitar textos redundantes
- corregir mojibake o acentos rotos cuando aparezcan

Eso aplica especialmente al dashboard master y sirve como referencia para otros módulos.

## 3. Qué se trabajó en Master

### 3.1 Drawer de nueva orden

Se refinó el drawer de nueva orden para hacerlo más compacto y coherente.

Cambios funcionales importantes:

- bloque `Cliente` reducido a datos obligatorios
- direcciones movidas al bloque `Entrega`
- lista de pedido más compacta
- composición de combos/platos más compacta
- drawer de precio reducido
- tipos y labels en español
- soporte para delivery por dirección 1 / dirección 2
- botón `Lo antes posible`
- urgencia visible en el flujo

También se corrigieron muchos textos mojibake visibles dentro de este flujo.

### 3.2 Entrega

Se rehízo bastante la tarjeta `Entrega`.

Comportamiento importante:

- por defecto arranca en `Pickup`
- si se cambia a `Delivery`, aparecen botones de direcciones guardadas
- `Dirección 1` se selecciona automáticamente al pasar a delivery
- `Lo antes posible` fija la hora como `ahora + 15 min`
- esa urgencia viaja con la orden y se usa también en el master

### 3.3 Detalle de la orden

Se trabajó la visual del drawer de detalle:

- se quitó el bloque `Próxima acción`
- se amplió el panel de acciones
- la pestaña `Pedido` fue corregida para distinguir:
  - `service`
  - `combo`
  - `product`

También se ajustó la lectura de servicios fraccionados:

- ejemplo: `0.5` servicio de 25 -> `12 und`
- la lógica acordada es redondear hacia abajo

### 3.4 Catálogo

Se hizo bastante limpieza conceptual y visual.

Puntos importantes:

- se restauró el campo `Tipo` en crear/editar catálogo
- `Inventariable` se quitó de la UI por redundante
- `Límite detalle` solo aparece si el producto es editable
- `Pago rider interno` se deja visible solo cuando tiene sentido
- se quitó `stock actual` del catálogo
- también se limpiaron campos redundantes de inventario en esa vista

Regla conceptual importante:

- `Catálogo` debe manejar la estructura comercial/operativa del producto
- `Inventario` debe manejar el stock vivo y movimientos

### 3.5 Composición + descuento de inventario

Aquí hubo una decisión importante:

- la composición comercial del producto y el descuento real de inventario no siempre son lo mismo

Caso típico:

- un combo/plato muestra `tequeños fritos`
- pero inventario debe bajar `tequeños crudos`

Se dejó encaminado así:

- `Composición` define lo comercial
- el descuento real de inventario se resuelve con la lógica configurada en los hijos

Además:

- los combos/platos editables ahora guardan la selección real del cliente
- el descuento de inventario usa esa composición real al entregar
- los opcionales fijos (ej. salsas) solo descuentan si fueron incluidos

## 4. Eventos / notificaciones

Esta es una de las partes más importantes que ya quedaron estructuradas.

### 4.1 Idea general

No se construyeron “toasts sueltos”.

Se construyó una base de eventos por orden reutilizable para:

- master
- advisor
- kitchen
- driver

### 4.2 Pestañas `Eventos` y `Notas`

Antes el historial automático estaba metido dentro de `Notas`.

Ahora quedó separado:

- `Eventos` = historial del sistema
- `Notas` = texto humano/manual

Esto está en:

- `C:\Users\bredy\Desktop\vivo-suite\vivo-ops\src\app\app\master\dashboard\MasterDashboardClient.tsx`

### 4.3 Tablas nuevas del timeline

El sistema nuevo NO debe usar la tabla legacy `public.order_events`.

Las tablas nuevas correctas son:

- `public.order_timeline_events`
- `public.order_timeline_event_recipients`

La definición base quedó documentada en:

- `C:\Users\bredy\Desktop\vivo-suite\vivo-ops\docs\order-events-v1.sql`

### 4.4 Problema legacy importante

Ya existía una tabla vieja:

- `public.order_events`

Y varias RPC viejas del sistema siguen escribiendo ahí:

- `approve_order`
- `send_to_kitchen`
- `mark_ready`
- `out_for_delivery`
- `assign_internal_driver`
- etc.

Eso generó conflicto cuando se intentó usar `order_events` para el sistema nuevo.

Solución aplicada:

- el timeline nuevo se movió a `order_timeline_events`
- la tabla vieja `order_events` se dejó solo para compatibilidad legacy

### 4.5 Compatibilidad de la tabla legacy

La tabla vieja `public.order_events` debe seguir soportando:

- `event`
- `performed_by`
- `meta`

Y no debe exigir `NOT NULL` en columnas nuevas que las RPC viejas no llenan:

- `event_type`
- `event_group`
- `title`
- `severity`
- `payload`

Esto fue importante para destrabar acciones como:

- aprobar
- enviar a cocina
- marcar preparada
- marcar entregada
- asignar motorizado

### 4.6 Carga y unificación de eventos

En `page.tsx` se combinan:

- eventos nuevos del timeline
- eventos legacy de `order_events`

Y se normalizan para que la UI del master los pueda leer juntos.

Archivo:

- `C:\Users\bredy\Desktop\vivo-suite\vivo-ops\src\app\app\master\dashboard\page.tsx`

### 4.7 Registro de eventos nuevos

En `actions.ts` quedó un helper central:

- `appendOrderEvent(...)`

Ese helper escribe en:

- `order_timeline_events`
- `order_timeline_event_recipients`

Archivo:

- `C:\Users\bredy\Desktop\vivo-suite\vivo-ops\src\app\app\master\dashboard\actions.ts`

## 5. Inbox del master

El botón `Alertas` dejó de ser una lista simple.

Ahora el master tiene una bandeja operativa.

### 5.1 Qué tiene

- `Tareas pendientes`
- `Actividad reciente`

### 5.2 Tareas pendientes ya incluidas

- aprobar
- re-aprobar
- confirmar pago
- enviar a cocina
- asignar driver
- cocina retrasada
- delivery retrasado

### 5.3 Filtros ya implementados

- `Tareas`
- `Retrasos`
- `Pagos`
- `Cambios`
- `Todo`

### 5.4 Agrupación de actividad

La actividad reciente quedó agrupada visualmente por:

- `Aprobación`
- `Cocina`
- `Delivery`
- `Pagos`
- `Cambios`

### 5.5 Mejoras semánticas

El inbox también se refinó para:

- usar `Orden: 100` en vez de `VO-...`
- traducir eventos legacy a español útil
- traducir cambios como frases humanas
- marcar órdenes urgentes / ASAP con `Urgente`

## 6. Supabase / estado del proyecto

Punto importante detectado:

- el proyecto remoto de Supabase apareció en pausa (`vivo-ops-prod`) en cierto momento
- eso puede explicar comportamientos raros aunque el código esté bien

Además, hay una cuestión de organización:

- la carpeta de Supabase está fuera del repo web:
  - `C:\Users\bredy\Desktop\vivo-suite\supabase`
- el repo git de la app está aquí:
  - `C:\Users\bredy\Desktop\vivo-suite\vivo-ops`

Y solo se vieron dos migraciones reales más muchos snippets sueltos:

- eso sugiere drift / cambios manuales no bien consolidados

## 7. Estado del asesor

Ya se definió conceptualmente el inbox del asesor, pero no se continuó aquí.

Se dejó una matriz funcional para asesor con filtros:

- `Pendientes`
- `Cocina`
- `Entrega`
- `Pagos`
- `Todo`

Y eventos V1 definidos como:

- `order_approved`
- `order_returned_to_review`
- `order_reapproved`
- `order_changes_rejected`
- `order_changes_approved`
- `order_sent_to_kitchen`
- `kitchen_taken`
- `kitchen_eta_updated`
- `kitchen_delayed_prep`
- `order_ready`
- `pickup_ready`
- `driver_assigned`
- `out_for_delivery`
- `delivery_delayed`
- `pickup_collected`
- `order_delivered`
- `payment_reported`
- `payment_confirmed`
- `payment_rejected`

Esto sirve como base para el otro hilo/mobile-first del asesor.

## 8. Qué está sensible / delicado

Estas son las zonas donde otro chat debe tener cuidado:

1. `MasterDashboardClient.tsx`
- archivo muy grande
- muchas reglas viven ahí
- no conviene hacer reemplazos masivos a ciegas

2. `order_events`
- no reutilizarla como sistema nuevo
- es tabla legacy

3. `Supabase`
- hay señales de drift entre migraciones y estado real

4. textos / codificación
- ya hubo bastantes problemas de mojibake
- mejor corregir puntual que con reemplazos globales agresivos

## 9. Siguiente paso recomendado

Por la línea que llevaba el trabajo, lo más lógico después de esto es:

1. seguir afinando el sistema de eventos solo si hace falta puntual
2. saltar al módulo `advisor`
3. construir el inbox del asesor reutilizando la base ya creada

Si se sigue en master:

- revisar si hace falta marcar lectura / no lectura
- o seguir refinando acciones rápidas dentro del inbox

Si se sigue en plataforma:

- auditar Supabase
- consolidar migraciones reales

## 10. Resumen corto para retomar

Si otro chat solo necesita una versión muy corta:

- el master ya tiene timeline por orden y inbox operativo
- `Eventos` y `Notas` ya están separados
- el sistema nuevo usa `order_timeline_events`, no `order_events`
- la tabla `order_events` es legacy y solo debe mantenerse compatible
- el próximo frente natural es `advisor` mobile-first reutilizando la base de eventos
