# Certificación — Fase 1 de Inventario General

Fecha: 2026-08-11

## Alcance cerrado

La Fase 1 cubre los bloques 34 a 38 y solamente la experiencia administrativa
de Inventario General:

1. navegación simplificada y carga bajo demanda del dominio;
2. perfil de ítem con calendario y responsable de conteo;
3. mínimos, objetivos, temporalidad y ciclo de vida reversible;
4. resumen práctico con existencias, compromisos y reposiciones;
5. contratos, permisos, documentación y verificación integral.

## Contratos reutilizados

| Necesidad | Centro de verdad |
| --- | --- |
| Saldo físico | `inventory_items.current_stock_units` + `inventory_movements` |
| Conteo programado | `primary_count_frequency` + `primary_count_role` |
| Conteo solicitado | frecuencia nula; sesiones `inventory_counts` existentes |
| Mínimo y objetivo | `low_stock_threshold` + `target_stock_units` |
| Compromisos y entradas | `inventory_planned_flows` mediante `inventory_reporting_workspace_v1(10)` |
| Producto temporal | `products.is_temporary` + `products.is_active` |
| Ítem retirado | `inventory_items.is_active` |
| Configuración comercial | `products` y escritores administrativos existentes |
| Descuento físico | `product_inventory_links`, `product_components` y revisiones existentes |
| Preparación | `inventory_recipes` versionadas |

No se creó ninguna tabla ni columna.

## Permisos

- Administración puede configurar perfiles y cambiar estados.
- Máster conserva lectura del centro actual; su adaptación operativa pertenece a
  la siguiente fase.
- Cocina, Asesor y Counter no recibieron cambios de interfaz en esta fase.
- Las funciones de estado verifican `user_roles.role = admin`, usan
  `security definer`, `search_path = ''` y solo conceden ejecución a
  `authenticated` y `service_role`.

## No bloqueo

Los cambios de estado no alteran saldos. Desactivar un producto conserva las
órdenes abiertas y devuelve `orders_blocked = false`. Retirar un ítem resuelve
sus alertas obsoletas, pero se rechaza si todavía participa en un producto,
receta o flujo activo. Ninguna de estas guardas veta crear, aprobar, preparar o
entregar una orden.

## Verificación

- Migración aplicada correctamente en Supabase producción.
- Ambas funciones verificadas como `security definer` con `search_path` vacío.
- Auditoría productiva: 54 ítems activos, 3 inactivos, 19 sin mínimo, 50 sin
  objetivo, 44 productos inactivos y 37 temporales.
- `npm.cmd run build`: aprobado después de cada bloque.
- ESLint dirigido a todos los archivos tocados por la fase: aprobado sin
  errores ni advertencias.
- El lint global sigue fallando por deuda previa en Advisor, Master, Orders y
  otras áreas no tocadas; Inventario no aparece entre esos errores.
- La aplicación local respondió HTTP 200. La automatización visual del navegador
  no logró completar la navegación local por tiempo de espera, por lo que la
  comprobación interactiva debe repetirse después del despliegue.

## Próximo bloque

Comienza la Fase 2, exclusivamente Módulo Máster:

- vista compacta de disponibilidad y compromisos;
- registro rápido de reposición esperada;
- alertas relevantes para decisión;
- suspensión comercial explícita con fecha de reanudación;
- pestaña de inventario dentro del detalle de la orden.

La Fase 2 debe consumir contratos de lectura reducidos; no debe montar todo el
configurador administrativo dentro de Máster.
