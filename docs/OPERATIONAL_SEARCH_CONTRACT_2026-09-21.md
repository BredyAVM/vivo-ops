# Búsqueda operativa de órdenes y clientes

## Regla canónica

- Buscar un cliente por nombre o teléfono no depende de que tenga una orden en
  `orders`. Los resultados separan órdenes operativas de fichas de clientes.
- Las compras importadas no se presentan como órdenes actuales ni se convierten
  en órdenes artificiales. La ficha comercial reúne ambas fuentes existentes.
- El número corto `orders.id` conserva prioridad. El teléfono no reemplaza el
  identificador de la orden ni altera teléfonos guardados.
- Máster Ops permanece dentro de su módulo. Abrir la ficha no cambia el día de
  agenda ni redirige a Dashboard.
- No se precarga el directorio ni el historial. La búsqueda es explícita,
  limitada; la ficha comercial se consulta solo al abrirla.

## Implementación

### Saldo en resultados de Máster Ops / Administración (2026-11-19)

El workspace operativo añade estado de pago e importe pendiente a cada resultado,
independientemente de que la orden esté entregada. Reutiliza la búsqueda base y
consulta `get_orders_financial_state` una vez por búsqueda explícita para hasta
20 IDs únicos (10 locales + 10 históricos). No carga saldos nuevos al abrir el
módulo ni ejecuta consultas por fila. La fecha operativa permanece sin cambios.

`searchOrderDirectoryWithPaymentsAction` valida sesión Máster/Admin y proyecta
solo saldo USD, saldo a favor y número de reportes pendientes. Un reporte por
revisar no se cuenta como pago. Respuestas incompletas/duplicadas/erróneas muestran
«Saldo no disponible», nunca un cero supuesto ni «Pagado». Canceladas remiten a
revisar pagos en el detalle. No se cambian RPC, permisos, escrituras o archivos
de Dashboard; el nuevo adaptador solo se consume en el workspace Máster/Admin.

Las guías Supabase/React orientan la consulta agrupada, autenticación por acción
y dependencias estables, sin precarga ni polling adicional.
Validación: `test:search-payments` (17), `test:orders-workspace` (32),
`test:master-read-efficiency` (13) y compilación de producción correctos.
Consulta real de solo lectura con contexto Máster: el RPC devuelve saldo, saldo
a favor y reportes pendientes para órdenes entregadas; no se modifica su historia.

- `searchMasterDirectoryAction` es la acción compartida de Máster Ops/Dashboard:
  órdenes existentes + hasta 8 fichas resumidas. Ambos muestran
  `MasterClientSearchResults`, con diálogo de ficha e historial.
- Se elimina la búsqueda suplementaria duplicada de Máster Ops; su acción de
  compatibilidad delega a `searchMasterOrdersAction`.
- `searchClientSummaries` consulta `search_clients_unaccent`, proyectando solo
  id, nombre, teléfono y asesor primario. El home del asesor la reutiliza.
- `search_phone_digits` normaliza exclusivamente para buscar: +58, 58, cero
  nacional, diez dígitos nacionales, espacios, guiones y prefijo 00. Conserva
  códigos internacionales explícitos. Las coincidencias parciales normalizadas
  exigen al menos cuatro dígitos.
- `search_clients_unaccent` busca teléfono principal, fiscal y nota de entrega;
  `search_master_orders` busca teléfono del cliente y receptor.
- La cartera paginada del asesor reutiliza la misma normalización y conserva sus
  filtros, paginación y función canónica de acceso.
- El cliente TypeScript usa `phone-search.ts` para la misma comparación local.

## Permisos y alcance

- Los cuatro RPC de búsqueda son SECURITY INVOKER. No se amplió ninguna política
  RLS ni se incorporó una clave privilegiada al navegador.
- Se conserva la lectura del directorio que ya estaba autorizada a los usuarios
  autenticados. Eso no concede lectura de pedidos ajenos.
- El asesor mantiene el filtro por `attributed_advisor_id`. Desde los resultados
  puede abrir la ficha de un cliente propio; para los demás se ofrece el acceso
  existente a crear pedido, sin abrir su perfil comercial restringido.
- La ficha de Máster usa el RPC autorizado `crm_master_client_profile_v1`.
- No se modifican datos de pedidos, importaciones, pagos, fondos, inventario o CRM.

## Migraciones aplicadas

1. `20260921150735_operational_phone_client_search.sql`: normalización, búsqueda
   telefónica compartida, índices de teléfono y cartera.
2. `20260921151108_phone_search_explicit_country_codes.sql`: conserva prefijos
   internacionales explícitos y reconstruye los dos índices derivados.

## Evidencia y pruebas

- Caso reportado: cliente 4629, Liseth Morán, teléfono +584140618841; 8 compras
  históricas, 0 compras operativas, última compra 20/02/2026.
- Consulta autenticada como Máster: el cliente aparece con +58, sin signo +,
  cero nacional, diez dígitos, espacios, guiones, prefijo 00, sufijo de siete
  dígitos y nombre sin acento.
- Una orden operativa real aparece por teléfono internacional/nacional y por
  número corto; el número exacto ocupa el primer resultado.
- Consulta autenticada con rol exclusivamente asesor: cliente encontrado;
  ninguna orden fuera de su alcance; cartera encuentra ambos formatos.
- `tests/search/operational-search.test.mts`: 12 pruebas aprobadas.
- Compilación de producción `npm run build` aprobada. Lint de los nuevos helpers
  y componente compartido aprobado.
- La verificación ejecutó lecturas; no se creó ni alteró una orden para probar.
- Pendiente de aceptación visual con sesión operativa: buscar el teléfono en
  ambos módulos, abrir y cerrar la ficha, revisar escritorio/móvil y confirmar
  que la fecha seleccionada se conserva.
