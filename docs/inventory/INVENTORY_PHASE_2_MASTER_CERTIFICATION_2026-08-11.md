# Certificación — Fase 2 de Inventario para Máster

Fecha: 2026-08-11

## Alcance cerrado

La Fase 2 adapta el centro canónico exclusivamente al Módulo Máster. No monta
el configurador administrativo completo ni modifica las interfaces de Cocina,
Asesor o Counter.

1. vista inicial compacta con existencias, compromisos y riesgos relevantes;
2. separación entre Resumen, Existencias y compromisos, y Conteos y revisiones;
3. registro rápido de reposiciones esperadas con cantidad exacta o desconocida;
4. alertas de inventario reducidas a asuntos que requieren acción de Máster;
5. suspensión comercial explícita por ítem, con reanudación fechada o indefinida;
6. pestaña Inventario dentro del detalle de cada orden.

## Contratos reutilizados

| Necesidad | Centro de verdad |
| --- | --- |
| Existencia y proyección | `inventory_reporting_workspace_v1(10)` |
| Alertas relevantes | `inventory_alert_workspace_v1('master_inventory', false)` |
| Reposición esperada | `inventory_save_expected_receipt_v1` y `inventory_cancel_expected_receipt_v1` |
| Suspensión comercial | `inventory_planned_flows.flow_type = 'declared_unavailability'` |
| Impacto de una orden | `inventory_preview_order_commitment_v1(order_id)` |
| Disponibilidad de catálogo | `inventory_catalog_availability_v1(target_at, product_ids, surface)` |

No se creó ninguna tabla ni columna. La migración de la fase solamente añadió
un índice parcial para suspensiones activas, dos comandos con control de rol y
una envoltura sobre los lectores canónicos existentes.

## Regla de no bloqueo

Un saldo bajo, cero, negativo, una apertura pendiente, un faltante proyectado o
la dependencia de una reposición producen contexto y alertas. Ninguna de esas
condiciones puede impedir aprobar, preparar, despachar o entregar una orden.

La única señal comercial restrictiva es una suspensión creada deliberadamente
por Máster o Administración. Esa suspensión:

- no cambia la existencia física;
- no cancela ni detiene órdenes ya creadas;
- se propaga a productos con componentes fijos obligatorios;
- termina automáticamente en la fecha indicada o permanece hasta reanudación;
- expone `inventory_blocks_submission = true` en el contrato de disponibilidad
  para que las fases posteriores de Asesor y Counter la consuman.

La interfaz actual de Asesor y Counter todavía no aplica ese indicador. Esta
fase solo deja el contrato listo y permite administrarlo desde Máster, evitando
mezclar cambios de otros módulos antes de su evaluación independiente.

## Lectura dentro de la orden

La pestaña Inventario muestra, por ítem físico:

- cantidad solicitada por la orden;
- existencia física;
- disponible sin afectar compromisos confirmados;
- cantidad comprometida antes de la fecha objetivo;
- faltante proyectado;
- dependencia de entradas esperadas;
- suspensión declarada y fecha de reanudación.

La consulta es tolerante. Si el lector de inventario falla, el resto del detalle
de la orden carga normalmente y presenta un mensaje informativo.

## Permisos

- Máster y Administración pueden registrar o cancelar reposiciones esperadas.
- Máster y Administración pueden suspender y reanudar ventas por ítem.
- Un Asesor no puede ejecutar los comandos de suspensión.
- Los comandos usan `security definer`, `search_path = ''`, validación interna
  de `user_roles` e idempotencia.

## Verificación

- Migración `20260811151740_inventory_master_commercial_suspensions_v1`
  aplicada en Supabase producción.
- Pruebas transaccionales reversibles aprobadas:
  - un faltante ordinario conserva el comportamiento no bloqueante;
  - una suspensión se aplica antes de su fecha de reanudación y desaparece
    después;
  - el Asesor es rechazado al intentar crearla;
  - la señal se propaga al catálogo;
  - la existencia física permanece intacta.
- Prueba productiva reversible aprobada sobre un ítem real; el `rollback`
  eliminó la suspensión de prueba.
- Analizadores de seguridad y rendimiento ejecutados después de la migración.
  Las dos funciones nuevas reciben la advertencia genérica de función
  `security definer` ejecutable por usuarios autenticados; su autorización
  interna por rol fue comprobada explícitamente.
- `npm.cmd run build`: aprobado después de los bloques de interfaz y contratos.
- ESLint dirigido a las interfaces nuevas: aprobado. El archivo histórico de
  acciones de Máster conserva deuda previa de `no-explicit-any` fuera de las
  líneas modificadas.
- El servidor local respondió y redirigió correctamente a `/login`, sin errores
  de consola. La inspección visual autenticada queda para el despliegue porque
  el navegador de prueba aislado no contiene una sesión de Máster.

## Commits de la fase

- `e058b89` — vista operativa compacta de Máster;
- `0da33a3` — controles de reposición esperada;
- `ec50bfb` — suspensiones comerciales declaradas;
- `bb7e25d` — contexto de inventario dentro de cada orden.

## Próxima fase

La Fase 3 pertenece exclusivamente a Cocina: selección del tipo de conteo,
listas por frecuencia y familia, captura rápida y cierre operativo. No debe
duplicar el libro de inventario ni trasladar controles administrativos a
Cocina.
