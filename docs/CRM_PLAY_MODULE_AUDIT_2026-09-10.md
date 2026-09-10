# Auditoría final del módulo CRM de jugadas

Fecha de cierre: 2026-09-10  
Entorno: producción (`vivo-ops.vercel.app`)  
Base de datos: Supabase `hbgxqrrybonavaigaetz`

## Resultado

El módulo quedó operativo de extremo a extremo para sus dos actores:

- Administración diseña, prueba, depura, confirma, publica, corrige y evalúa jugadas.
- El asesor recibe únicamente sus clientes publicados, ejecuta el contacto con acciones rápidas, consulta el guion y aplica el beneficio desde el pedido.
- La ficha viva del cliente permanece actualizada; cada jugada conserva además su snapshot e historial inmutable.
- Los beneficios, ampliaciones, inversión de empresa y cargo del asesor quedan congelados por jugada y pedido.

## Bloques publicados

1. `f0e1f97` — seguimiento compacto del asesor y mensajes personalizados.
2. `3505f79` — beneficio de jugada seguro dentro del pedido y sin datos internos visibles al cliente.
3. `cddd5d8` — supervisión operativa por asesor.
4. `429594b` — separación entre aplicación directa e influencia posterior; anulación segura de canjes.
5. `1ab7f36` — consumo real de presupuesto, costos y relación con comisiones.
6. `1903634` — memoria completa de jugadas en la ficha del cliente.
7. `ae138b5` — copia periódica, siguiente mes y linaje de versiones.

## Integridad del histórico

| Control | Resultado |
|---|---:|
| Órdenes/eventos históricos listos | 31.731 |
| Líneas históricas | 96.703 |
| Registros enlazados a clientes actuales | 31.731 (100%) |
| Clientes actuales con histórico | 6.247 |
| Primer registro | 2023-01-05 |
| Último registro | 2026-05-31 |
| Registros desde el corte vivo del 2026-06-01 | 0 |
| Obsequios sin compra conservados en cero | 2.103 |
| Total histórico sin IVA | USD 781.031,89 |
| Total esperado por el manifiesto | USD 781.031,89 |

El histórico no crea deuda ni saldo pendiente. Las órdenes vivas empiezan desde el corte y no se duplican con el archivo histórico.

## Cartera y adjudicación

De los 6.247 clientes con histórico:

- 5.095 tienen asesor principal activo.
- 1.152 permanecen huérfanos porque no existe evidencia suficiente para adjudicarlos con seguridad.
- Las jugadas congelan el asesor correspondiente en su snapshot; un cambio posterior de cartera no reescribe la publicación anterior.

## Finanzas y comisiones

- El aporte de la empresa es el único valor que consume el presupuesto de la jugada.
- El cargo del asesor entra como deducción de obsequio en su cierre de comisión.
- La diferencia que paga el cliente al ampliar un beneficio conserva precio y es comisionable.
- Una orden cancelada anula el canje, libera o vence el beneficio según la vigencia y evita el cargo de comisión.
- La evaluación directa solo cuenta pedidos entregados que contienen el beneficio.
- La influencia posterior se informa aparte y solo para clientes contactados que respondieron.

## Rendimiento y peso

- `historical_orders`: 31.731 filas, 19 MB totales.
- `historical_order_items`: 96.703 filas, 24 MB totales.
- `crm_play_members`: 38 filas activas durante la auditoría, 2,4 MB totales incluyendo índices.
- Resumen administrativo de la jugada activa: aproximadamente 18 ms en base de datos.
- Perfil comercial del cliente con histórico vivo: aproximadamente 24 ms en base de datos.

El histórico funciona como hechos comerciales y no como órdenes operativas; por eso no carga cocina, pagos, caja, inventario ni deuda. El impacto actual es bajo y no se observó degradación relevante.

## Seguridad

- Row Level Security permanece activa en las tablas CRM expuestas.
- Un asesor auditado vio una jugada compartida, cero borradores y cero snapshots privados.
- Las funciones nuevas de supervisión y copia rechazaron al asesor con error de autorización.
- Las funciones con privilegios elevados fijan `search_path = ''` y tienen concesiones explícitas.
- La función interna que anula canjes solo es ejecutable por el propietario de la base mediante el trigger de pedidos.

Los asesores globales de Supabase todavía reportan deuda técnica anterior y ajena a este módulo: tablas privadas o de respaldo con RLS sin política, funciones heredadas con `search_path` mutable y claves foráneas sin índice. Debe tratarse en una auditoría transversal separada para no alterar superficies operativas fuera del CRM:

- [RLS sin política](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
- [Ruta mutable en funciones](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable)
- [Claves foráneas sin índice](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys)

## Verificación de aplicación

- Compilación de producción de Next.js: aprobada.
- ESLint completo: aprobado sin errores.
- Pruebas CRM: 9 de 9 aprobadas.
- Pruebas de comisiones: 77 de 77 aprobadas.
- Migraciones CRM nuevas: presentes en la base remota.
- Vercel: despliegue de producción `READY`, creado inmediatamente después de `ae138b5`, con alias principal activo.
- Registros recientes de Vercel: sin errores de aplicación del CRM; aparecen dos avisos de deprecación de Node en `/app/master/ops`, con respuesta HTTP 200 y fuera de este módulo.

La comprobación visual autenticada no pudo ejecutarse desde la sesión de auditoría porque el navegador estaba desconectado de la cuenta. Se verificó la redirección correcta al acceso y se cubrieron permisos, consultas, compilación y producción por las superficies de Supabase y Vercel.

## Criterio de cierre

Los ocho bloques definidos para la incorporación histórica y el módulo de jugadas están terminados. El sistema conserva una separación clara entre datos vivos, snapshots de jugadas y hechos históricos, y permite cambiar parámetros futuros —incluida la ventana usada para calcular frecuencia— sin reimportar ni duplicar órdenes.
