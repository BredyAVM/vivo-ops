# Bloque 16: preparación del corte canónico

Fecha: 2026-08-08

Estado: **diagnóstico implementado; apertura física real todavía pendiente**.

## Resultado

El Bloque 16 agrega una auditoría derivada y de solo lectura. No crea tablas,
columnas, índices, estados persistidos ni un segundo centro de verdad.

La RPC `inventory_cutover_readiness_v1()` revisa en una sola lectura:

- políticas del catálogo activo;
- vínculos `product_inventory_links` versión 1;
- ciclos y profundidad de combos/componentes;
- definiciones y activación de recetas canónicas;
- aperturas aceptadas, pendientes y en revisión;
- resolución de órdenes abiertas y sus compromisos;
- compromisos huérfanos;
- guardas críticas del libro y de órdenes;
- cobertura de los roles Admin, Master, Cocina, Asesor y Counter;
- conteos, producciones y entradas esperadas pendientes.

La ruta independiente `/app/inventory/readiness` muestra el mismo resultado bajo
demanda. No se carga desde la dashboard ni precarga el Centro de Inventario.

## Estado auditado en Supabase

En la verificación del 2026-08-08:

- 144 productos del catálogo tenían configuración `ready`;
- 103 productos estaban activos;
- 108 vínculos canónicos versión 1 eran válidos;
- no existían ciclos ni rutas de componentes demasiado profundas;
- las 13 salidas preparadas tenían receta canónica válida;
- las órdenes abiertas auditadas resolvían sin errores ni compromisos
  desalineados;
- las siete guardas críticas estaban instaladas y habilitadas;
- los cinco roles operativos tenían usuarios asignados;
- la estructura resultó `structural_ready=true`;
- la operación resultó `operational_ready=false` porque faltaban 47 aperturas y
  la activación gradual de 13 recetas canónicas;
- el modo permanecía `legacy`;
- no existían movimientos canónicos ni conteos de apertura reales.

La cantidad de órdenes abiertas es dinámica y la página la vuelve a comprobar en
cada entrada.

## Diferencia entre estructura y operación

`structural_ready` significa que las reglas, dependencias, permisos y órdenes
actuales son coherentes. No activa inventario.

`operational_ready` requiere además:

1. aperturas aceptadas para todos los ítems rastreados;
2. cero conteos o reconteos pendientes;
3. las 13 recetas canónicas activas;
4. cero producciones canónicas en curso;
5. los controles estructurales todavía conformes.

La activación de recetas debe hacerse gradualmente. Primero se abren y aceptan sus
insumos y salidas; luego Administración activa cada receta liberada. Así las
recetas nuevas quedan activas antes de aceptar el último ítem que deriva el modo
`canonical`.

## Secuencia segura de apertura

1. Confirmar todos los controles estructurales.
2. Elegir una ventana operativa controlada.
3. Contar primero insumos y salidas de prefritos y salsas.
4. Revisar esos conteos y activar cada receta que quede sin bloqueos.
5. Completar los demás ítems y resolver todos los reconteos.
6. Confirmar que no hay preparaciones canónicas abiertas.
7. Aceptar el último ítem; ese acto deriva el modo `canonical`.
8. Verificar lectura, producción, recepción y consumo por entrega.
9. Observar el motor antes de retirar escritores legados.

La coordinación de la ventana no bloquea crear, agendar ni enviar órdenes. Para
evitar una mezcla de escritores, durante el intervalo entre la primera apertura y
la última aceptación no deben cerrarse entregas. Esta es una condición futura del
corte, no un cambio aplicado ahora.

## Orden de integración de los otros módulos

Los otros chats deben consumir contratos pequeños; nunca cargar el Centro de
Inventario completo:

1. **Master**: lectura compacta de existencia, compromisos, alertas y último
   conteo. Master conserva la decisión final.
2. **Cocina**: entradas reales, producción, conteos, averías, mermas y pruebas de
   calidad mediante los comandos canónicos existentes.
3. **Asesor**: seleccionar fecha/hora primero y luego consultar
   `inventory_catalog_availability_v1` con `advisor_availability`. La advertencia
   es informativa y el asesor siempre puede enviar al Master.
4. **Counter**: seleccionar fecha/hora primero y consultar la misma frontera con
   `counter_inventory`. La entrega consume por el motor central cuando el modo ya
   sea canónico.

Las adaptaciones de Master, Cocina, Asesor y Counter no forman parte del Bloque
16 y deben realizarse en sus chats correspondientes.

## Seguridad

- Solo Master y Administración pueden ejecutar la auditoría.
- Asesor, Counter, Cocina, `anon` y `PUBLIC` no reciben acceso.
- La función es `STABLE`, no contiene comandos de escritura y valida el rol
  dentro de la función.
- Supabase Advisor emite el aviso esperado
  [`0029_authenticated_security_definer_function_executable`](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable):
  la exposición a `authenticated` es intencional para que Master/Admin consuman
  la RPC, y el control interno de rol fue probado contra Asesor.
- `inventory_blocks_orders=false` y `blocks_order_submission=false` son parte
  explícita del resultado.
- La consulta no activa recetas, aperturas, movimientos ni el corte.

## Archivos

- `supabase/migrations/20260808185556_inventory_cutover_readiness_v1.sql`;
- `src/lib/inventory/readiness.ts`;
- `src/app/app/inventory/readiness/page.tsx`;
- `docs/inventory/INVENTORY_BLOCK_16_TRANSACTION_TESTS_2026-08-08.sql`.
