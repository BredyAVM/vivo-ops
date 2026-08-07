# Bloque 6: snapshots y compromisos de pedidos

Fecha: 2026-08-07

Estado: aplicado y verificado en Supabase; sin apertura de saldos, descuento
físico ni cambios en Máster, Counter, Cocina, Asesor o Finanzas.

## Resultado

Las órdenes aprobadas ya producen una demanda física fechada y trazable sin
convertirla en una salida de inventario. Se reutilizaron las tablas existentes:

- `order_item_components` congela la composición comercial real;
- `inventory_planned_flows` conserva los compromisos de pedidos y las entradas
  o producciones esperadas;
- el resolver del Bloque 5 determina las hojas físicas y cantidades;
- `inventory_movements` continúa reservado exclusivamente para hechos físicos.

No se creó ninguna tabla ni columna. Se agregaron restricciones, índices,
funciones y triggers sobre las estructuras auditadas.

## Composición congelada

Cada alta o modificación de un `order_item` valida los marcadores estructurados
vigentes y guarda en `order_item_components`:

- componentes fijos obligatorios;
- selecciones configurables;
- componentes opcionales elegidos;
- cantidad y nombre comercial al momento del pedido.

Una selección mal formada, no permitida o que no complete el límite comercial
se rechaza al escribir. Los usuarios autenticados no pueden insertar, editar ni
borrar snapshots directamente.

## Ciclo de vida del compromiso

| Estado del pedido | Regla de inventario |
| --- | --- |
| `created` | solicitud tentativa; no compromete |
| aprobado en `queued` o estado operativo posterior | crea o reconstruye el compromiso |
| entrega dentro de 10 días | compromiso `active` |
| entrega a más de 10 días | compromiso `draft`; no presiona la lectura operativa actual |
| requiere nueva aprobación | cierra el compromiso abierto |
| Máster reaprueba | resuelve otra vez y crea el compromiso vigente |
| vuelve a `created` o se cancela | compromiso `cancelled` |
| se entrega | compromiso `fulfilled` |

La automatización usa triggers pequeños de base de datos para acompañar el ciclo
de vida existente. No cambia estados del pedido, no aprueba solicitudes y no
bloquea al Asesor.

## Disponibilidad protegida

La capacidad en una fecha protege el saldo mínimo proyectado desde esa fecha
hasta el final del horizonte móvil de diez días. Considera:

- existencia física abierta;
- compromisos aprobados anteriores y posteriores;
- recepciones esperadas activas;
- producciones planificadas activas.

La previsualización puede responder:

- `available`;
- `insufficient`;
- `relies_on_incoming`;
- `outside_horizon`;
- `requires_opening`;
- `no_inventory_effect`.

Una insuficiencia informa al Asesor o al Máster; no impide enviar la solicitud.
Si la aprobación depende de reposición, esa dependencia queda visible para la
decisión del Máster.

## Caso canónico probado

Con 550 piezas físicas, 500 comprometidas para mañana y una solicitud de 200
para hoy:

- sin reposición, la disponibilidad protegida es 50 y faltan 150;
- con una recepción activa de 200 antes del compromiso de mañana, la capacidad
  es 250;
- el segundo resultado queda marcado `relies_on_incoming`, no como existencia
  física incondicional.

También se probó que un evento de 2.000 piezas a once días conserva su compromiso
como `draft` y no lleva la lectura operativa a negativo durante todo el mes.

## Permisos

- Asesor: previsualiza únicamente órdenes atribuidas a sí mismo; no reconstruye
  compromisos ni escribe snapshots.
- Máster y Administración: previsualizan cualquier orden y pueden reconstruir
  un compromiso aprobado.
- una modificación del Asesor nunca renueva por sí sola el compromiso aprobado;
  el compromiso revisado nace al reaprobar Máster.
- Cocina y Counter: conservan lectura operativa de los datos que ya necesitan;
  no administran compromisos mediante el RPC.
- `anon`: no lee snapshots ni ejecuta los RPC.

Los RPC públicos son `SECURITY DEFINER` intencionalmente, tienen
`search_path = ''`, validan `auth.uid()` y `user_roles` dentro de la función y
revocan ejecución a `PUBLIC` y `anon`.

## Verificación real

Después de aplicar las migraciones `20260807192344`, `20260807192602` y
`20260807193006`:

- 11 órdenes abiertas quedaron representadas;
- 43 líneas físicas de compromiso quedaron activas;
- 24 snapshots de componentes quedaron congelados;
- cero órdenes y cero líneas difieren del resolver canónico;
- ningún ítem está abierto todavía;
- el último movimiento físico es anterior al primer compromiso creado.

Las pruebas completas se ejecutaron nuevamente con `ROLLBACK`. No dejaron
fixtures, movimientos ni saldos de prueba.

## Frontera y siguiente bloque

El siguiente bloque debe preparar la línea base y el corte operativo: permitir
el conteo físico inicial desde el Centro de Inventario, registrar la apertura
mediante el comando ya instalado y definir el cambio controlado desde los
escritores heredados hacia los comandos canónicos. No se debe activar un
descuento real antes de esa apertura.
