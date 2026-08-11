# Certificación de Inventario — Fase 3 Cocina

Fecha: 2026-08-11  
Estado: **implementada, aplicada en producción y publicada en `main`**.

## Alcance cerrado

La fase adapta exclusivamente el inventario a la operación de Cocina. No duplica
el libro, no mueve configuración administrativa al módulo y no consulta estos
datos al cargar la cola principal de pedidos.

Cocina dispone de:

- una entrada simple que prioriza **Hacer inventario**;
- navegación con sección activa: Inicio, Inventariar, Entradas, Producción,
  Calidad y Alertas;
- un conteo por cada Turno 1 y Turno 2 de la fecha operativa;
- selección futura de inventarios diario, semanal, quincenal y mensual;
- listas derivadas de la frecuencia y responsable configurados por
  Administración;
- filtro rápido por familia y progreso sin perder cantidades capturadas;
- conteo ciego por presentaciones completas, unidades sueltas o fracciones;
- respuesta a solicitudes y reconteos selectivos abiertos;
- conteo puntual cuando Máster lo solicita fuera del cierre completo;
- historial reciente con responsable, fecha y estado;
- alertas separadas de control, sin mezclarlas con pedidos.

## Fuente de verdad reutilizada

No se creó una tabla de calendarios ni otra entidad de existencias. Se reutilizan:

- `inventory_items.primary_count_frequency`;
- `inventory_items.primary_count_role`;
- `inventory_counts` e `inventory_count_lines`;
- `inventory_item_presentations`;
- `inventory_alerts` y sus políticas por superficie;
- `inventory_submit_count_v1` e `inventory_submit_staged_recount_v1`.

Los valores nulos continúan significando conteo solo por solicitud. Los nuevos
consumibles que Administración incorpore podrán seleccionar su frecuencia y
responsable desde el configurador existente; Cocina los recibirá automáticamente
en la lista correspondiente después de su apertura física.

## Calendario y alertas

`20260811153310_kitchen_inventory_shifts_v1.sql` completa la identidad auditable
del turno con fecha Caracas, código de turno y usuario que presenta. Abrir el
mismo turno dos veces reanuda el encabezado existente; no genera un duplicado.

`20260811153622_inventory_kitchen_count_schedule_v1.sql` reutiliza las
frecuencias del ítem y agrega:

- vencimiento del turno al terminar su fecha operativa en Caracas;
- alerta si un Turno 1 o Turno 2 no fue registrado;
- alerta agregada cuando un programa diario, semanal, quincenal o mensual vence;
- resolución automática al completar el conteo.

Las alertas indican que el inventario está pendiente, pero nunca bloquean una
orden ni impiden presentar un conteo tardío. No se generan alertas históricas
anteriores a la activación del 2026-08-11.

## Contrato operativo

1. Administración configura en el perfil del ítem la frecuencia y responsable.
2. Cocina abre **Inventariar** y selecciona el momento correspondiente.
3. La pantalla muestra solo los ítems activos, inicializados y asignados a ese
   programa.
4. El saldo esperado permanece oculto.
5. Cocina debe escribir una cantidad para todos los ítems; cero es una cantidad
   válida.
6. Presentar ajusta inmediatamente el saldo a lo contado y deja el reporte en
   revisión.
7. Máster ve el reporte completo y puede aceptarlo o pedir reconteos específicos.
8. Un reconteo vuelve a Cocina únicamente con los ítems señalados.

La revisión de Máster no retrasa el ajuste físico: quien cuenta es responsable
de lo capturado. El estado posterior conserva la trazabilidad de conformidad o
reconteo.

## Estado productivo auditado

Al certificar:

- 49 ítems activos admiten conteo físico;
- 48 están inicializados y asignados a Cocina por turno;
- todavía no hay ítems de Cocina configurados como diarios, semanales,
  quincenales o mensuales;
- no existe ningún conteo operativo de prueba persistido;
- no hay suspensiones comerciales activas;
- no hay alertas de calendario abiertas o residuales;
- las tres migraciones recientes aparecen registradas en Supabase producción.

Esto es coherente con la decisión de no inventar consumibles inexistentes: los
ciclos adicionales quedan disponibles para los productos que Administración
configure posteriormente.

## Verificación

- ESLint dirigido a acciones, páginas y componentes modificados: aprobado.
- Seis pruebas unitarias de operaciones de Cocina: aprobadas.
- `npm.cmd run build`: aprobado con TypeScript y las 40 rutas.
- Prueba transaccional reversible:
  - apertura y repetición idempotente de un turno;
  - vencimiento correcto en Caracas;
  - detección única de un ciclo semanal vencido;
  - presentación canónica del conteo periódico;
  - resolución automática de su alerta;
  - `ROLLBACK` y cero datos de prueba persistidos.
- Asesores de Supabase revisados después del DDL: no apareció una observación
  nueva atribuible a estas funciones o índices. Los avisos existentes pertenecen
  a deuda previa fuera de este alcance.

El guion reproducible es
`INVENTORY_PHASE_3_KITCHEN_TRANSACTION_TESTS_2026-08-11.sql`.

## Límites preservados

- No se modificó `/app/master/dashboard`.
- No se modificaron Counter, Asesor ni Finanzas.
- No se cambió el flujo de creación, aprobación, preparación o entrega de
  órdenes.
- Saldo bajo, cero, negativo o conteo vencido siguen siendo señales, no vetos.
- Solo una suspensión comercial explícita de Máster o Administración puede
  detener la oferta futura del producto; nunca cancela ni bloquea una orden ya
  creada.

## Commits de la fase

- `5d8f7cf` — identidad de turnos, vencimientos y alertas de calendario;
- `8385c2f` — ciclos periódicos, filtros y captura operativa;
- `c12b2d5` — entrada y navegación simplificadas de Cocina;
- `7190cca` — guía final, estados vacíos y fecha mensual alineada.

Con esta certificación termina la ruta de tres fases acordada: Inventario
General, Módulo Máster y Cocina. Los cambios visuales futuros de Counter o
Asesor deben trabajarse en sus propios módulos consumiendo los contratos ya
publicados; no forman parte de esta fase.
