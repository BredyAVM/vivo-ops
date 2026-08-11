# Certificación de mejoras de Counter

Fecha operativa: 2026-08-10  
Módulo: `/app/counter`  
Alcance excluido: `/app/master/dashboard`

## Resultado

La agenda de doce bloques quedó implementada o certificada sobre las fuentes
canónicas existentes. Counter continúa siendo un mostrador operativo y una caja
registradora diaria; no se convirtió en un dashboard financiero ni adquirió
autoridad de Master o Administración.

No se creó una segunda fuente de verdad financiera. Los cobros, cambios,
devoluciones, caja y liquidaciones siguen cerrando sobre los movimientos y las
cuentas canónicas. Las consultas pesadas continúan bajo demanda y paginadas.

## Estado por bloque

| Bloque | Resultado | Evidencia principal |
| --- | --- | --- |
| 1. Cotización canónica | Implementado | `286d90b`, RPC `counter_read_payment_quote` |
| 2. Referencia del punto | Implementado | `aef04eb`, últimos cuatro dígitos obligatorios para POS |
| 3. Agenda y pago opcional | Implementado | `d100aac`, una orden futura puede quedar sin cobro inmediato |
| 4. Asesor habitual | Implementado | `973e29f`, asesor primario o último asesor real |
| 5. Asignación desde Master Ops | Implementado | `243e982`, sin tocar Master Dashboard |
| 6. Fecha antes del catálogo | Certificado | `bd599a3`, disponibilidad V1 por fecha en una sola lectura acotada |
| 7. Edición directa de pickup | Certificado | `d8851e4`, motivo obligatorio al reducir; delivery rechazado |
| 8. Salida delivery | Implementado | `bbcb175`, solo crea custodia cuando existe efectivo o cambio prescrito |
| 9. Histórico y búsqueda | Certificado | `8818b7b` y `b8f0dec`, carga bajo demanda y paginación |
| 10. Sincronización ligera | Certificado | `acbd229`, Realtime como señal y reparación por recurso |
| 11. Pruebas integradas | Certificado | suite transaccional completa e invariantes de producción |
| 12. Experiencia y cierre | Certificado técnicamente | estructura exclusiva, accesibilidad, build y este documento |

## Migraciones de esta agenda

- `20260811022301_counter_canonical_payment_quote`
- `20260811022840_counter_pos_last_four_reference`
- `20260811024141_counter_client_advisor_context`
- `20260811025832_counter_advisor_role_context`
- `20260811030904_counter_delivery_prescription_quote`

No todos los bloques requirieron SQL. Cuando la estructura canónica ya cubría
el caso, se reutilizó y se evitó crear tablas, RPC o índices redundantes.

## Reglas operativas verificadas

- Pickup listo con cobro inmediato no se entrega antes de cerrar el cobro.
- Pickup activo puede editarse en Counter; una reducción exige motivo.
- Delivery no puede modificar productos desde Counter.
- Delivery puede salir sin estar pagado cuando el cobro corresponde al asesor.
- Un delivery sin efectivo ni cambio prescrito no crea liquidación para Counter.
- Si existe efectivo o cambio prescrito, la salida conserva la custodia abierta
  hasta el retorno, incluso entre días.
- La entrega física y el estado de pago permanecen independientes.
- Una orden entregada solo admite consulta y registro de pagos pendientes.
- POS exige los últimos cuatro dígitos de referencia.
- Los productos nacidos en VES conservan el snapshot exacto antes o el día de
  entrega; la mora posterior se revaloriza con la tasa de la operación.
- Una venta futura creada por Counter puede quedar agendada sin pago inmediato.
- El cliente es obligatorio y se muestra su asesor habitual cuando existe.
- Master Ops puede asignar el asesor responsable sin atribuir la venta al
  mostrador ni modificar `/app/master/dashboard`.

## Peso y consultas

- cola activa cargada al entrar;
- detalle exacto cargado al seleccionar una orden;
- catálogo cargado al abrir venta o edición;
- caja y liquidaciones cargadas solo mientras su sección está abierta;
- entregados de hoy cargados solo al abrir `Entregados hoy`, 20 por página;
- búsqueda profunda ejecutada solo al solicitarla, 10 por página;
- disponibilidad de inventario consultada en una llamada acotada de hasta 200
  productos, sin consultas por producto;
- Realtime despierta la reparación; no reemplaza las lecturas exactas del
  servidor ni mantiene un refresco ciego de toda la pantalla.

## Evidencia técnica final

- suite SQL transaccional existente: pickup, pago de orden entregada,
  idempotencia de cobro/cambio y custodia delivery parcial/final aprobados con
  `ROLLBACK`;
- recibos duplicados: `0`;
- recibos atascados: `0`;
- movimientos confirmados inválidos: `0`;
- liquidaciones con estado o fecha incoherente: `0`;
- funciones Counter ejecutables por `anon`: `0`;
- funciones `SECURITY DEFINER` de Counter sin `search_path` vacío: `0`;
- cuentas activas visibles por Counter: `5`;
- cuentas visibles fuera del perímetro directo de Counter: `0`;
- ESLint de `/app/counter`: aprobado;
- TypeScript `--noEmit`: aprobado;
- `next build`: aprobado;
- cuatro advertencias de lint en `master/ops/page.tsx` provienen de código
  anterior (commits de julio) y no de esta agenda;
- `/app/master/dashboard`: sin modificaciones.

## Experiencia y accesibilidad

- fecha operativa visible junto al título `Counter`;
- navegación exclusiva entre Pedidos, Nueva venta, Caja, Liquidaciones,
  Entregados hoy y Buscar orden;
- filtros horizontales Listos, En cocina, Pickup y Delivery;
- listas a la izquierda y detalle a la derecha en cola e histórico diario;
- controles principales con foco visible y tamaño táctil;
- búsqueda etiquetada, selección y filtros con estado semántico;
- errores y confirmaciones anunciados como alertas o estados;
- secciones grandes divididas en chunks y cargadas bajo demanda.

## Aceptación pendiente

La ruta local fue abierta durante la auditoría y redirigió correctamente a
`/login`. No había una sesión Counter autenticada disponible y no se creó un
bypass ni una identidad de prueba. Falta únicamente una pasada visual humana
con un operador Counter real en el monitor del local: ancho disponible,
legibilidad, uso con teclado/táctil y los flujos de pago y despacho. Esto no es
un defecto de implementación ni bloquea el despliegue técnico.

## Cierre

La agenda no deja un bloque de programación pendiente. Los hallazgos nuevos que
aparezcan en operación deben tratarse como correcciones puntuales y conservar
las reglas de este documento y del contrato canónico de Counter.
