# Preparacion piloto asesores - 2026-05-28

Objetivo: llegar al lunes con el sistema listo para operar en paralelo con el sistema actual, sin cargar historico completo de ordenes todavia.

Secuencia acordada:

- domingo 2026-05-31: adiestramiento de asesores, permitiendo crear ordenes de prueba.
- lunes 2026-06-01: blanqueo operativo real antes de comenzar el piloto.

## Estado medido

Supabase actual:

- `clients`: 6076
- `orders`: 247
- `order_items`: 588
- `payment_reports`: 151
- `money_movements`: 143
- `order_timeline_events`: 978
- `order_timeline_event_recipients`: 2309
- `order_admin_adjustments`: 41
- `order_events` legacy: 831
- `products`: 92
- `money_accounts`: 15

Base real `base Clientes.csv`:

- filas: 6284
- telefonos interpretables: 6279
- telefonos invalidos: 5
- grupos duplicados por telefono canonico: 32
- filas dentro de duplicados: 64

## Decision recomendada

1. Mantener los dos sistemas en paralelo durante el piloto.
2. Vaciar datos operativos de prueba el lunes antes del arranque real: ordenes, items, pagos, movimientos ligados a ordenes, timeline y ajustes.
3. No borrar catalogo, cuentas, reglas financieras, usuarios, roles ni productos.
4. Mantener clientes actuales saneados y migrar/actualizar faltantes solo con la lista final del lunes 2026-06-01.
5. No importar historico de ordenes todavia.

## Antes de correr el reset

- No correr el reset antes del adiestramiento del domingo, porque se usaran ordenes de prueba para mostrar el flujo.
- Confirmar que no haya una operacion real en curso.
- Tomar backup/snapshot desde Supabase.
- Confirmar que el ultimo deploy de Vercel tenga build exitoso.
- Tener a mano una orden de prueba para validar despues.

## Despues del reset

Smoke test minimo:

- Asesor crea cliente nuevo con telefono tipo `0414...`.
- Asesor busca cliente por `0414`, `414` y `+58414`.
- Asesor crea orden pickup y delivery.
- Asesor copia WhatsApp presupuesto y resumen de pedido.
- Asesor reporta pago movil/transferencia/zelle con campos obligatorios.
- Master confirma pago.
- Master cierra diferencia de redondeo pequena si aplica.
- Master devuelve orden al asesor para recalculo.
- Asesor corrige y la alerta sale del inbox.
- Master envia a cocina.
- Cocina/local valida flujo de pedido.
- Push de master/advisor funciona en al menos dos equipos.

## Monitoreo del piloto

Durante el primer dia:

- Revisar Supabase CPU/RAM/IO si aparece alerta de recursos.
- Revisar si el dashboard master tarda mas de lo normal.
- Evitar deploys grandes en horas activas.
- Solo hacer hotfixes puntuales con build verificado.

## Riesgos conocidos

- El dashboard master concentra mucha data operativa; si vuelve el timeout, hay que paginar o cachear mas.
- Las ordenes historicas no deben entrar al piloto inicial.
- Los duplicados de clientes de la lista final deben revisarse antes de insertarlos.
- Si se importan clientes con telefonos invalidos, se rompe la calidad de busqueda.

## Lista final de clientes

No importar clientes antes de recibir la lista final del lunes 2026-06-01. La base revisada hoy sirve solo para diagnosticar calidad de datos y anticipar problemas; no debe usarse como importacion definitiva.

El SQL de staging queda preparado para ese momento:

- cargar CSV final en `public.client_import_stage`
- revisar invalidos
- revisar duplicados dentro del CSV
- revisar coincidencias contra `public.clients`
- insertar solo telefonos validos, unicos y que no existan

Si la lista final trae cambios sobre clientes ya existentes, se debe hacer como actualizacion controlada por telefono canonico, no como duplicado nuevo.
