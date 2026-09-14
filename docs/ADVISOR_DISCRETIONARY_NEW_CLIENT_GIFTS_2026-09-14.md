# Obsequios discrecionales de cliente nuevo

## Regla operativa confirmada

El asesor decide si entrega el obsequio de cliente nuevo. Es opcional y puede
entregarse después de la primera compra. No exige pertenencia a una Jugada.
Las promociones que sí pertenecen a Jugadas conservan sus validaciones de
cliente, asesor, selección, vigencia y canje.

## Corrección

La restricción general de productos Gambit del catálogo CRM también alcanzaba
a los dos Dondys de cliente nuevo, impidiendo guardarlos en una orden normal.
La clasificación explícita `catalog_access_scope = advisor_gift` separa estos
obsequios de `crm_only`. Se aplica únicamente a `GAMBIT_DONDY_1_CN` y
`GAMBIT_DONDYS_3`; no se reactivan productos retirados ni se abren otras campañas.

- El catálogo de Asesor muestra los obsequios clasificados explícitamente.
- La base permite al asesor asignado, Máster o Administración incorporarlos.
- Se mantiene el precio al cliente en cero, sin convertir el obsequio en cobro.
- No se crean reservas ni canjes CRM para un obsequio independiente.
- Se conservan las cantidades, recetas, vínculos de inventario y costos de
  obsequios para comisiones ya configurados.
- Un Gambit sin clasificación explícita sigue restringido.

## Inventario y correcciones históricas

Una orden nueva conserva el consumo normal al producirse su salida física.
Esta migración no modifica órdenes históricas, pagos ni inventario.

Si el propietario confirma una entrega efectuada fuera del programa y ordena
no repetir su descuento, la regularización debe ser individual y auditada:
preservar el movimiento original y los saldos físicos, registrar el obsequio a
cero y conservar los pagos. No habilitar una excepción general que permita a
operadores omitir inventario en nuevas ventas.

Separar siempre la fecha real de entrega de la fecha de registro de la
corrección. Si solo se conoce el día, no inventar una hora de entrega. Los
lectores canónicos actuales usan la fecha programada cuando falta
`delivery.completed_at`; solo es válido conservar esa referencia cuando
coincide con la fecha real confirmada.

Los detalles de mantenimiento de órdenes reales quedan en el historial y la
auditoría privada de la base, no en este repositorio público.

## Verificación

- `npm run test:order-details`: catálogo regular, obsequios independientes y CRM.
- `npm run test:order-pricing`: regresión de precios USD/VES y ajustes a cero.
- `npm run test:admin` y `npm run test:security`.
- `npm run build`.
- `tests/crm/advisor-discretionary-gifts.rollback.sql`: integración con limpieza
  automática; compra posterior, tres roles operativos, denegación anónima y de
  asesor ajeno, orden sin asesor, precio cero, separación CRM e inventario intacto.
- `tests/crm/master-order-benefit.rollback.sql`, dentro de `BEGIN/ROLLBACK`:
  regresión de beneficios y ampliaciones reales de Jugadas.

Migración: `20260914135042_advisor_discretionary_new_client_gifts.sql`.
