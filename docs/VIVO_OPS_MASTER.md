# VIVO-OPS — Master Doc (Schema + Reglas + Rutas)

> **Objetivo:** Tener un solo lugar (fuente de verdad) para no perder nombres, reglas, enums, triggers y el mapa del sistema.
>
> **Regla de oro:** Si se cambia un nombre/regla en DB o en código, se actualiza aquí el mismo día.

---

## 1) Stack y estructura del proyecto

* **Repo/Workspace:** `vivo-suite/vivo-ops`
* **Frontend:** Next.js (App Router) + TypeScript
* **Backend/DB:** Supabase (Postgres)
* **Cliente Supabase:** `src/lib/supabase.ts`
* **Env:** `.env.local`

### Rutas (Next.js App Router)

* `/orders` → `src/app/orders/page.tsx`
* `/orders/[id]` → `src/app/orders/[id]/page.tsx` (Server wrapper)
* `/orders/[id]` (UI/queries) → `src/app/orders/[id]/OrderDetailClient.tsx` (Client)

### Gotchas confirmados (Next.js)

* En rutas dinámicas, **leer params en Client con `useParams()`** para evitar `undefined`/"sync dynamic apis".

---

## 2) Convenciones de nombres (no negociar)

* **Tablas/columnas en inglés**.
* Las relaciones usan `*_id`.
* Snapshots para precios/nombres:

  * `unit_price_usd_snapshot`, `product_name_snapshot`, `sku_snapshot`.
* Cantidad en items: **`qty`** (no `quantity`).

---

## 3) Tablas clave (public)

### 3.1 `orders`

**Columnas (resumen):**

* `id` (bigint)
* `order_number` (text)
* `client_id` (bigint)
* `created_by_user_id` (uuid) **NOT NULL**
* `source` (enum) **NOT NULL**
* `attributed_advisor_id` (uuid)
* `fulfillment` (enum)
* `delivery_address` (text)
* `receiver_name` (text)
* `receiver_phone` (text)
* `status` (enum)
* `total_usd` (numeric)
* `notes` (text)
* `created_at` (timestamptz)
* `extra_fields` (jsonb)
* `is_price_locked` (boolean)
* `delivery_mode` (enum) (tiene default, pero **reglas aplican**)
* `external_driver_name` (text)
* `external_driver_phone` (text)
* `external_partner_id` (bigint)
* `external_reference` (text)

> Nota: `delivery_mode` aparece con default `'pickup'::delivery_mode`, pero hay trigger que valida coherencia con `fulfillment`.

### 3.2 `order_items`

**Columnas (resumen):**

* `id` (bigint)
* `order_id` (bigint)
* `product_id` (bigint)
* `qty` (numeric)
* `unit_price_usd_snapshot` (numeric)
* `line_total_usd` (numeric)
* `product_name_snapshot` (text)
* `sku_snapshot` (text)
* `notes` (text)
* `created_at` (timestamptz)
* `override_unit_price_usd` (numeric)
* `override_reason` (text)
* `override_approved_by` (uuid)
* `override_approved_at` (timestamptz)

### 3.3 `products`

**Columnas (resumen):**

* `id` (bigint)
* `sku` (text)
* `name` (text)
* `is_active` (boolean)
* `is_combo` (boolean)
* `base_price_usd` (numeric)
* `created_at` (timestamptz)
* `extra_fields` (jsonb)

---

## 4) Enums (valores confirmados)

### 4.1 `delivery_mode`

* `pickup`
* `internal`
* `external`

### 4.2 `source`

* `advisor`
* `master`
* `walk_in`

> Otros enums existen (ej. `fulfillment`, `status`), pero se documentan aquí apenas se confirmen/usen.

---

## 5) Triggers / reglas (lo que te está protegiendo)

### Triggers vistos en `orders`

* `orders_delivery_mode_guard` → `trg_orders_delivery_mode_guard()`
* `orders_external_partner_guard` → `trg_orders_external_partner_guard()`
* `orders_lock_guard` → `trg_orders_lock_guard()`

### Reglas confirmadas (mensajes reales)

* **"Pickup orders must not have delivery_mode."**

  * Implica: si `fulfillment = 'pickup'`, entonces `delivery_mode` debe ser **NULL** (o el trigger lo exige así).

> Importante: Aunque `delivery_mode` tenga default `'pickup'`, esta regla puede requerir que **NO se guarde** en pickup.

---

## 6) UI de pruebas actual (lo que ya funciona)

### `/orders` (lista + botones de prueba)

* Carga últimas 10 órdenes.
* Crea pedidos de prueba:

  * Pickup (Master)
  * Pickup (Advisor)
  * Pickup (Walk-in)
* Crea pedido + 1 item:

  * Inserta en `orders`.
  * Selecciona 1 producto activo.
  * Inserta en `order_items` con snapshots.
  * Actualiza `orders.total_usd` (manual por ahora).

### `/orders/[id]` (detalle + items)

* Lee `id` usando `useParams()` en Client.
* Consulta `order_items` por `order_id`.

---

## 7) Queries útiles (para no perder tiempo)

### Ver columnas de una tabla

```sql
select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'orders'
order by ordinal_position;
```

### Ver valores de un enum

```sql
select unnest(enum_range(null::delivery_mode)) as delivery_mode_values;
select unnest(enum_range(null::source)) as source_values;
```

### Buscar funciones que contengan un texto (ej. driver_id)

```sql
select
  n.nspname as schema,
  p.proname as function_name
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosrc ilike '%driver_id%';
```

### Listar triggers de una tabla

```sql
select
  trigger_name,
  event_manipulation,
  action_timing,
  action_statement
from information_schema.triggers
where trigger_schema = 'public'
  and event_object_table = 'orders'
order by trigger_name;
```

---

## 8) Pendientes inmediatos

1. **Documentar enums faltantes** (`fulfillment`, `status`) con sus valores reales.
2. Definir regla final de `delivery_mode` para pickup:

   * Opción A: permitir NULL para pickup y sin default.
   * Opción B: guardar `delivery_mode = 'pickup'` y ajustar trigger.
3. Recalcular `orders.total_usd` en DB (trigger/func) en vez de manual.
4. Página de detalle de orden: mostrar encabezado de la orden (no solo items).

---

## 9) Checklist de “cuando salga un error”

* ¿Es un tema de **nombre de columna**? → revisar **Table Editor → Columns** o query `information_schema.columns`.
* ¿Es un tema de **enum**? → `enum_range`.
* ¿Es un tema de **trigger**? → listar triggers y revisar función.
* ¿Es `undefined`/params? → mover a Client + `useParams()`.

---

## 10) Historial de decisiones

* `order_items.qty` (✅) en vez de `quantity`.
* `orders.fulfillment` (✅) existe; no `fulfillment_type`.
* `source` enum: `advisor | master | walk_in`.
* `delivery_mode` enum: `pickup | internal | external`.
* Regla activa: pickup no debe tener delivery_mode (según trigger).
