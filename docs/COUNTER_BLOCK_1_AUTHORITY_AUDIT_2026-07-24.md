# Auditoría e implementación del Bloque 1 de Counter

Fecha: 2026-07-24

Documentos rectores:

- `docs/COUNTER_CANONICAL_CONTRACT_2026-07-24.md`
- `docs/COUNTER_IMPLEMENTATION_ROADMAP_2026-07-24.md`

Estado:

- auditoría focalizada: completada;
- implementación local: completada;
- build de producción: aprobado;
- migración remota: aplicada;
- prueba de autoridad con Counter puro: aprobada;
- advisors de seguridad y rendimiento: revisados;
- Bloque 1: cerrado en su alcance.

## 1. Alcance aplicado

Este bloque solo cubre autoridad y perímetro de seguridad:

- admisión a `/app/counter`;
- helpers y matrices de rol;
- lecturas operativas mediante RLS;
- comandos estrechos para pagos y despacho;
- grants explícitos para RPC;
- índices de soporte;
- eliminación de una consulta redundante.

No se implementaron todavía:

- el comando atómico de retiro pickup;
- el nuevo modelo de liquidación de delivery;
- cobros mixtos y cambios atómicos;
- devoluciones y autorizaciones;
- búsqueda histórica definitiva;
- refactor visual;
- optimización general de la carga.

Esas capacidades conservan su bloque asignado en la hoja de ruta.

## 2. Hallazgo crítico de la auditoría

La función `public.is_master_or_admin()` aceptaba como administrador a
`current_user in ('postgres', 'supabase_admin')` incluso cuando existía un
`auth.uid()` real.

Dentro de una función `SECURITY DEFINER` propiedad de Postgres, esto podía hacer
que un usuario autenticado heredara de forma indirecta una comprobación positiva
de Master/Admin.

La migración preparada cambia la regla:

1. si existe `auth.uid()`, la decisión depende exclusivamente de `user_roles`;
2. el bypass de Studio solo existe cuando no hay usuario autenticado;
3. el `search_path` queda fijado;
4. los permisos `EXECUTE` dejan de ser públicos o anónimos.

## 3. Mapa RLS antes y después

| Recurso | Antes para Counter puro | Después preparado |
| --- | --- | --- |
| `orders` | sin lectura propia | solo órdenes operativas y ventas Counter en `created` |
| `order_items` | dependía de otro rol | ítems de las órdenes operativas visibles |
| `profiles` | sin acceso a su perfil ni nombres operativos | perfil propio y perfiles activos |
| `payment_reports` | sin lectura propia | reportes creados por el mismo operador |
| `money_movements` | sin lectura | confirmados de cuentas directas del Counter |
| `money_account_closures` | Master/Admin | lectura de cierres de cuentas directas |
| `money_account_closure_baselines` | Master/Admin | lectura de baselines de cuentas directas |
| `money_account_closure_profiles` | RLS sin política útil | lectura directa; escritura solo Master/Admin |

No se agregó una política general de `INSERT`, `UPDATE` o `DELETE` para Counter
sobre órdenes, reportes, movimientos, cierres o cuentas.

## 4. Cuentas y pagos

La autoridad directa del Counter se obtiene de
`money_account_payment_rules`, no del nombre mostrado en la interfaz.

Una cuenta directa requiere:

- cuenta activa;
- regla activa para `counter`;
- `can_confirm_payment = true`;
- `auto_confirms_report = true`;
- `review_required = false`.

Las reglas Counter asociadas a cuentas cuyo nombre contiene `Floresta` se
desactivan mediante una actualización por atributos, sin usar ids generados.

Consecuencias:

- efectivo y POS configurados como directos pueden autoconfirmarse;
- bancos y billeteras de reporte permanecen pendientes de Master;
- Counter no puede confirmar un reporte bancario;
- Counter solo puede autoconfirmar un reporte creado por sí mismo;
- cuenta, moneda y monto nativo no pueden cambiar durante esa confirmación.

## 5. RPC y comandos

### Endurecidos

- `has_role(text)`
- `get_my_roles()`
- `is_master_or_admin()`
- `create_payment_report(...)`
- `confirm_payment_report(...)`
- `get_orders_financial_state(...)`
- `out_for_delivery(bigint)`
- `mark_delivered(bigint)`
- `search_clients_unaccent(text, integer)`

Todos los RPC anteriores usados por Counter quedan sin ejecución para `PUBLIC` y
`anon`; su ejecución se concede de forma explícita a `authenticated` y
`service_role`.

### Nuevo comando estrecho

`counter_dispatch_order(bigint, integer)`:

- exige Counter, Master o Admin;
- bloquea la orden;
- exige modalidad delivery;
- exige estado `ready`;
- exige asignación interna o externa válida;
- valida ETA entre 1 y 1440 minutos cuando existe;
- cambia estado, ETA y trazabilidad en una transacción;
- registra evento operativo y destinatarios.

Counter no recibe permiso general para actualizar `orders`.

### Entrega final

El RPC heredado `mark_delivered` queda restringido a Master/Admin. Se eliminan
del camino heredado los permisos de cocina y motorizado que contradicen el
contrato canónico.

El retiro pickup por Counter no se habilita parcialmente aquí porque hoy la
acción heredada separa estado, metadatos, inventario y eventos. Su reemplazo
atómico pertenece a los Bloques 2 y 5.

## 6. Aplicación

Cambios preparados:

- guard canónico `isCounterOperatorRole`;
- guard de servidor `requireCounterOperatorContext`;
- todas las acciones exclusivas de Counter reutilizan el mismo guard;
- el despacho de Counter llama a su RPC local y ya no importa la acción de
  despacho desde `/app/master/dashboard`;
- la matriz de dominio devuelve la asignación al Master y el despacho al
  Counter;
- motorizado no obtiene control de estados finales del sistema;
- la página elimina la consulta directa a `payment_reports`;
- los conteos de reportes se toman de `get_orders_financial_state`;
- las cuentas directas se derivan del tipo y de las reglas activas.

No se modificó ningún archivo dentro de:

```text
src/app/app/master/dashboard/
```

## 7. Archivos

Aplicación:

- `src/lib/auth.ts`
- `src/lib/domain/order-domain.ts`
- `src/lib/domain/delivery-domain.ts`
- `src/app/app/counter/page.tsx`
- `src/app/app/counter/actions.ts`
- `src/app/app/counter/CounterClient.tsx`

Migración central preparada:

```text
C:\Users\bredy\Desktop\vivo-suite\supabase\migrations\
20260724220209_counter_block1_authority_boundary.sql
```

## 8. Matriz de prueba de la migración

### Positivas

1. Counter puro obtiene `get_my_roles() = ['counter']`.
2. Counter puro abre `/app/counter`.
3. Ve órdenes `confirmed`, `in_kitchen`, `ready` y `out_for_delivery`.
4. Ve ventas Counter en `created`.
5. Ve ítems y nombres operativos asociados.
6. Ve saldos agregados sin leer reportes ajenos.
7. Reporta un pago bancario y queda `pending`.
8. Reporta y confirma un pago directo propio.
9. Despacha un delivery `ready` con asignación y ETA.
10. Ve movimientos y cierres de las cuentas directas autorizadas.

### Negativas

1. Advisor, cocina y motorizado no ejecutan `counter_dispatch_order`.
2. Counter no confirma un reporte bancario.
3. Counter no confirma un reporte creado por otro usuario.
4. Counter no cambia cuenta, moneda o monto al confirmar.
5. Counter no despacha una orden pickup.
6. Counter no despacha delivery sin asignación.
7. Counter no despacha desde un estado distinto de `ready`.
8. Counter no ve movimientos de bancos ni de Floresta.
9. Counter no inserta o actualiza directamente órdenes o dinero.
10. Counter no ejecuta cancelación, cambio de modalidad ni asignación.
11. Motorizado y cocina no marcan una orden como entregada.
12. Un usuario autenticado sin Master/Admin obtiene
    `is_master_or_admin() = false`.

### No regresión

1. Master y Admin conservan sus lecturas y comandos.
2. Advisor conserva lectura financiera únicamente de sus órdenes.
3. Cocina conserva toma y preparación, no entrega final.
4. El dashboard de Master no tiene diff.
5. El build de toda la aplicación continúa aprobando.

## 9. Evidencia de verificación

- `npm.cmd run build`: aprobado.
- `git diff --check`: aprobado; solo advertencias de final de línea de Windows.
- `npm.cmd run lint`: no aprobado por deuda previa del repositorio:
  132 errores y 72 advertencias distribuidos en múltiples módulos.
- Supabase local: no disponible porque Docker no está iniciado.
- Migración remota aplicada:
  `20260724230435_counter_block1_authority_boundary`.
- El archivo aplicado conservó el SHA-256 revisado:
  `E5154F1E64454DEB3578DD991AA069A0CB4E5CD33D15DFD88D7A84B464353ED8`.
- La simulación transaccional con rol exclusivamente `counter` confirmó
  `is_master_or_admin() = false`.
- Counter pudo crear su propio reporte bancario pendiente.
- Counter no pudo confirmar ese reporte bancario.
- Counter no pudo despachar una orden pickup ni ejecutar el cierre heredado de
  delivery.
- Los roles originales y todos los datos usados en la prueba fueron restaurados;
  no quedaron reportes ni movimientos de prueba.
- Los advisors no mostraron un bloqueo nuevo causado por la migración. Conservan
  advertencias genéricas sobre RPC `SECURITY DEFINER` protegidos y deuda previa
  de grants, índices y políticas fuera del alcance de este bloque.

## 10. Resultado de cierre

El Bloque 1 queda cerrado en autoridad y perímetro de seguridad:

- la migración versionada está aplicada;
- Counter no hereda autoridad de Master/Admin;
- los rechazos sensibles probados funcionan;
- el build está aprobado;
- `/app/master/dashboard` no fue modificado.

No existía una orden delivery activa que estuviera simultáneamente `ready` y
asignada al momento de la verificación. Por ello, el despacho positivo completo
se repetirá con una orden elegible antes de certificar el flujo de delivery del
Bloque 6. Esta salvedad no amplía permisos ni deja pendiente la frontera de
seguridad del Bloque 1.
