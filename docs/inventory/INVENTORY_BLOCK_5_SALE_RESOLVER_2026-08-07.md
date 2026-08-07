# Bloque 5: resolución canónica de ventas

Fecha: 2026-08-07

Estado: aplicado y verificado en Supabase; sin apertura de saldos ni conexión a
Máster, Counter, Cocina o Asesor.

## Resultado

Una orden ya puede convertirse de forma determinista en cantidades físicas de
inventario. La resolución usa exclusivamente identidades y relaciones
estructuradas; nunca busca productos o ítems por nombre.

No se creó ninguna tabla ni columna. Se reutilizaron:

- `order_items` como raíz comercial de la venta;
- `product_components` como plantilla fija, seleccionable u opcional;
- `order_item_components` como snapshot preferente de la selección real;
- los marcadores estructurados `@sel|producto|cantidad` como compatibilidad
  temporal para pedidos existentes que todavía no llenan el snapshot;
- `product_inventory_links` versión 1 para llegar a las hojas físicas;
- `inventory_movements.operation_id` para la operación idempotente;
- el motor atómico privado instalado en el Bloque 4.

`order_item_components` recibió solamente dos invariantes que faltaban: cantidad
positiva y una sola fila por pedido/componente.

## Reglas de resolución

1. Un producto `self` o `direct` termina en sus vínculos físicos versión 1.
2. Un producto `components` expande componentes fijos y la selección real.
3. Un producto `none` es válido y no produce movimiento.
4. Un componente dentro de un combo expresa piezas. Por ejemplo, cinco mini
   tequeños consumen cinco crudos, no cinco servicios de 25.
5. Un producto vendido directamente expresa servicios. El medio servicio se
   calcula con la regla comercial: 25 se convierte en 12, 20 en 10 y Dondy de
   seis en tres.
6. `order_item_components` tiene prioridad completa. Solo si el pedido no tiene
   snapshot se leen marcadores `@sel`; el texto visible nunca decide inventario.
7. Se agregan por identidad física todas las ramas que terminan en el mismo
   ítem.
8. Una configuración incompleta, un marcador inválido, una selección no
   permitida, un ciclo o una cantidad incoherente detienen toda la operación.

La previsualización pública está limitada a Administración y Máster. Devuelve
las líneas físicas, cantidades, productos de origen y fuente de cada selección,
sin escribir stock.

## Comando de venta

`inventory_commit_order_sale_v1` deja preparado el descuento atómico, pero no
está conectado a ningún dominio operativo. El comando:

- solo acepta órdenes `delivered`;
- valida Administración o Máster dentro de la función;
- usa bloqueos por operación, orden e ítems físicos;
- exige apertura previa de todos los ítems;
- impide existencias negativas;
- escribe todos los `sale_out` con signo negativo o ninguno;
- permite reintentar el mismo UUID sin duplicar movimientos;
- impide una segunda operación activa para la misma orden;
- bloquea órdenes que ya tienen descuento legado;
- permite un nuevo descuento únicamente después de revertir por completo el
  anterior;
- acepta órdenes compuestas solo por productos `none` como una operación sin
  efecto físico.

## Catálogo corregido

El producto 164, `Degustación Prefritos (8 und)`, quedó `ready` con política
`direct`. Consume exactamente:

- 2 mini tequeños crudos;
- 2 cachitas crudas;
- 2 Bombys crudos;
- 1 empanada cruda;
- 1 mandoca cruda.

El vínculo viejo del mini tequeño apuntaba a un alias fusionado y no rastreable;
la versión canónica apunta al ítem físico vigente. La composición visual de
prefritos no participa en el descuento.

El producto 129, Dondys Cumpleaños de seis piezas, heredó correctamente la regla
de medio servicio de tres piezas.

Con estos cambios, los 144 productos vivos están en estado canónico `ready` y
los 108 vínculos versión 1 terminan en ítems operativos.

## Cobertura verificada

- prueba sintética conjunta de degustación, medio mini tequeño, medio Dondy,
  combo fijo y Single Pack configurable;
- prioridad del snapshot sobre una nota deliberadamente inválida;
- rechazo de un marcador inválido cuando no existe snapshot;
- Evento abierto, Single Pack real y Combo Rumba real;
- todas las órdenes abiertas resolvieron sin errores en los cortes anterior y
  posterior a la aplicación;
- 1.509 de 1.514 órdenes no canceladas del historial resolvieron canónicamente;
- las cinco excepciones son pedidos entregados antiguos con cantidades
  comerciales incompatibles con su detalle, y quedan protegidos contra doble
  descuento por el guardado legado;
- aplicación, replay, segundo UUID rechazado, reverso completo y recompromiso;
- Asesor autenticado rechazado tanto en previsualización como en confirmación;
- orden exclusivamente no inventariable sin movimiento;
- prueba completa ejecutada otra vez después de aplicar y finalizada con
  `ROLLBACK`.

No se abrió ningún ítem y no se creó ningún movimiento canónico. Las pruebas no
alteraron saldos reales.

## Seguridad

Las dos funciones auxiliares viven en `app_private`, son `SECURITY INVOKER` y no
pueden ejecutarlas `anon` ni `authenticated`. Los dos RPC públicos son
`SECURITY DEFINER` de forma intencional, usan `search_path = ''`, rechazan
`anon` y comprueban `auth.uid()` y `user_roles` antes de leer o escribir.

El asesor de Supabase reporta los dos RPC públicos como funciones privilegiadas
ejecutables por usuarios autenticados. Es una advertencia esperada: el acceso
genérico no concede autoridad porque cada RPC aplica la comprobación de rol en
su cuerpo. No aparecieron observaciones de rendimiento para los objetos nuevos.

## Frontera y siguiente bloque

La venta todavía no descuenta inventario real. El próximo bloque debe congelar
`order_item_components` al crear o modificar pedidos y representar compromisos
fechados dentro del horizonte de diez días. Solo después se coordinarán el
conteo de apertura y el cambio del escritor legado al comando atómico.

No se modificó código de Máster, Counter, Cocina, Asesor ni Finanzas.
