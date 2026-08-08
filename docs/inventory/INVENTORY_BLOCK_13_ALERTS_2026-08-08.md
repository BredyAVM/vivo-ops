# Bloque 13 — Alertas configurables de inventario

Fecha: 2026-08-08

## Resultado

Inventario tiene un centro de alertas propio. No reutiliza `notifications`,
`order_timeline_events` ni `master_inbox_item_states` como buzón general, porque
esas estructuras pertenecen al flujo de órdenes.

La solución separa tres conceptos:

1. `inventory_alert_policies`: activa o desactiva una categoría. La política
   puede ser general o una excepción para un ítem.
2. `inventory_alert_policy_routes`: define el rol y la superficie donde se
   muestra una política.
3. `inventory_alerts`: conserva el episodio detectado y su ciclo de vida
   (`open`, `managed`, `resolved`).

Una excepción por ítem prevalece sobre la política general. Al eliminarla, el
ítem vuelve a heredar la política general inmediatamente.

## Categorías canónicas

- `availability`: disponibilidad comercial visible para quienes venden.
- `commitment`: riesgo sobre compromisos y pedidos futuros.
- `production`: preparación, reposición, rendimiento o recepción esperada.
- `control`: conteos, diferencias y reconteos.
- `procurement`: niveles mínimos y necesidad de compra.
- `system`: fallas de resolución o integridad que requieren revisión interna.

## Superficies configurables

- `inventory_center`: centro independiente para Master y Administración.
- `advisor_availability`: adaptador futuro de lectura para Asesor.
- `master_inventory`: adaptador futuro del módulo Master.
- `kitchen_inventory`: adaptador futuro de Cocina.
- `counter_inventory`: adaptador futuro de Counter.
- `admin_inventory`: adaptador futuro de Administración.

Las rutas futuras quedan configurables, pero este bloque no modifica esos
módulos. Ninguna alerta bloquea creación, aprobación, preparación o entrega de
órdenes.

## Valores reutilizados

No se duplicaron parámetros que ya existían en `inventory_items`:

- `low_stock_threshold` y `low_stock_inclusive` disparan el nivel bajo.
- `target_stock_units` expresa el objetivo de reposición o producción.
- `primary_count_frequency` y `primary_count_role` gobiernan conteos.
- `availability_mode`, recetas y tiempos gobiernan capacidad inmediata o futura.

## Actualización segura

El detector es determinista y deduplica por `alert_key`: solo existe un episodio
abierto o en gestión para una misma condición. Cuando la condición desaparece,
el episodio se resuelve; una recurrencia posterior crea un episodio nuevo.

El cálculo se ejecuta al abrir o actualizar explícitamente el Centro de Alertas.
No se instalaron triggers sobre órdenes, productos, conteos o movimientos. Esto
evita añadir latencia y propagación de fallas a los flujos operativos actuales.
Una ejecución programada podrá añadirse después sin cambiar el contrato.

## Audiencia inicial

- Disponibilidad: Asesor, Master y Administración.
- Compromisos, procura y sistema: Master y Administración.
- Producción y control: Cocina, Master y Administración.

Administración puede ajustar estas rutas, desactivar categorías, crear
excepciones por ítem y editar umbral/objetivo desde
`/app/inventory/alerts`. Master recibe la lectura del centro, sin acceso a la
configuración.

## Verificación del bloque

- Seis políticas generales creadas.
- Rutas normalizadas y restringidas a combinaciones rol/superficie válidas.
- RLS y permisos explícitos en las tres tablas.
- Las tablas no se exponen a `authenticated`; los clientes pasan por RPCs con
  control de rol y superficie. Esto evita que un adaptador lea detalles internos.
- Administración ve configuración; Master no puede leerla directamente.
- Asesor solo puede usar su superficie de disponibilidad.
- Cero triggers de refresco y cero destinatarios agregados al timeline de órdenes.
- El estado actual produce cero falsas alertas antes de la apertura física.

El asesor de seguridad de Supabase conserva una advertencia intencional para
`inventory_alert_workspace_v1`: es un RPC `security definer` ejecutable por
usuarios autenticados. La función valida `auth.uid()`, rol y superficie antes de
leer, y es precisamente la frontera segura que reemplaza el acceso directo a
tablas.
