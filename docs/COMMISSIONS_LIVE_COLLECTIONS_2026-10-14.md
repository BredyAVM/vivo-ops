# Cobranza posterior a conformidad y pago

## Contrato

- `payable_usd`, el porcentaje y el snapshot conformado son el acuerdo histórico. Nunca se regeneran por cobros posteriores.
- `advisor_commission_collections_v1` consulta la cobranza canónica de todas las órdenes del snapshot y los traslados recibidos. Solo considera pagos validados y fondos efectivamente aplicados.
- La disponibilidad actual es el crédito acordado después de deducibles, menos deuda de clientes actual. El pendiente resta todos los abonos confirmados vinculados; una reversión vuelve a liberar únicamente el saldo de ese mismo cierre.
- `paid` significa que se cubrió el monto acordado original. No significa que la cobranza terminó. Una liquidación pagada puede recibir abonos adicionales por crédito posteriormente liberado, con el mismo comando atómico, control de límites y clave de reintento.
- No se recalculan metas, bandas, porcentajes, cargos ni precios de órdenes al consultar cobranza.

## Propiedad de los arrastres

- Preparar un preliminar posterior no traslada ni copia automáticamente el crédito de un cierre anterior.
- Administración elige un preliminar posterior del mismo asesor y registra el motivo. Se traslada todo el crédito aún no pagado, la deuda propia y las referencias de órdenes que mantienen la cobranza. No se recrean órdenes ni pagos.
- Una fuente admite un solo destino. El traslado y los abonos se serializan por asesor y bloquean las mismas filas. Repetir el traslado al mismo destino no duplica nada; otro destino se rechaza.
- Después del traslado, el origen sigue mostrando la situación de sus órdenes y el destino, pero no admite nuevos abonos ni rectificaciones que rompan la evidencia. El nuevo período exige su propia conformidad antes de pagar.
- Los arrastres históricos ya conformados se concilian únicamente cuando el sucesor inmediato del mismo asesor contiene exactamente la retención original. Las propuestas preliminares antiguas no otorgan propiedad. Los saldos iniciales manuales y los traslados explícitos no se acumulan en un mismo preliminar.
- No se realizan traslados nuevos de clientes reales durante la verificación o el despliegue. La decisión sigue siendo administrativa.

## Datos y seguridad

Una sola tabla de evidencia: `advisor_commission_carry_transfers`. Se reutilizan cierres, snapshots, movimientos y recibos existentes, sin añadir columnas financieras duplicadas a órdenes o cierres. Las escrituras solo se permiten mediante comandos con autorización administrativa, datos validados y transacciones. Los lectores comprueban identidad y alcance; el asesor solo consulta su propia liquidación.

Si no se verifica la cobranza completa, se muestra advertencia y no se habilitan pagos. Los importes históricos no se presentan como un saldo actual confirmado. Las vistas consultan automáticamente cada 30 segundos mientras están visibles y al recuperar foco; existe actualización manual, independiente del botón de recalcular preliminares.

## Verificación

Pruebas Postgres aisladas: cobranza parcial, abono adicional sobre un acuerdo pagado, inmutabilidad, reintentos, bloqueo de sobrepago, traslado exclusivo, pagos solo en destino, conformidad, reversión, permisos y rechazo de lectura incompleta. Pruebas de lectura verifican que se conserve la base neta sin IVA y las condiciones especiales.

Comandos: `npm run test:commission-collections`, `npx tsc --noEmit -p tsconfig.build.json`, lint y compilación de producción. El proyecto comprueba los tipos de producción con `tsconfig.build.json`; los arneses de pruebas Node se ejecutan por separado. La validación en producción debe comparar los saldos actuales con los pagos reales sin registrar abonos ni cambiar acuerdos para probar.

Resultado: 139 pruebas específicas aprobadas, TypeScript y compilación correctos. La batería general de administración tiene 126 aprobadas y un fallo preexistente de `admin-shell-boundary` por consultas directas de los módulos de premios/evaluación; esas consultas ya están en `origin/main` y no se modificaron aquí. El análisis de seguridad no arroja avisos nuevos para estas funciones ni para la nueva tabla, que se consulta solo mediante comandos protegidos, sin acceso directo de `anon` o `authenticated`.
