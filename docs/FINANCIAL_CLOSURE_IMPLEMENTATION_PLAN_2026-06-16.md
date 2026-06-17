# Plan de implementacion de cierres financieros - VIVO Ops

Fecha: 2026-06-16

Este plan aterriza la politica canonica de finanzas sobre las cuentas que ya existen en produccion, sin perder control sobre movimientos, pagos ni cierres anteriores.

## Situacion actual revisada

La aplicacion ya tiene:

- `money_accounts` como catalogo de cuentas.
- `money_movements` como fuente real de saldos.
- `money_account_closures` como tabla inicial de cierres.
- Acciones de dashboard para crear cuentas, editar cuentas, listar movimientos y registrar cierres.

El cierre actual funciona como una primera version, pero calcula el esperado sumando todos los movimientos confirmados de una cuenta desde el inicio. Todavia no distingue:

- saldo inicial o cierre anterior
- periodo del cierre
- diferencias heredadas
- diferencias clasificadas
- reglas por tipo de cuenta
- puntos que transfieren a banco
- retenciones como cuenta fiscal/documental

Por eso no conviene modificar directamente las cuentas actuales ni recalcular cierres antiguos sin una capa intermedia.

## Cuentas actuales y perfil recomendado

| Cuenta | Moneda | Tipo actual | Perfil de cierre recomendado |
| --- | --- | --- | --- |
| BDV Juridico | VES | bank | bank |
| C.CH Dark BS | VES | cash | cash |
| Zelle VIVO | USD | bank | bank |
| Punto BNC | VES | pos | pos |
| BNC Juridico | VES | bank | bank |
| BDV Bredy | VES | bank | bank |
| C.CH Dark $ | USD | cash | cash |
| C.CH Floresta Bs | VES | cash | cash |
| C.CH Floresta $ | USD | cash | cash |
| Punto BDV 1 | VES | pos | pos |
| Punto BDV 2 | VES | pos | pos |
| Binance | USD | wallet | wallet_usd |
| Paypal | USD | wallet | wallet_usd |
| Zelle Ahorro | USD | bank | bank |
| Retenciones | VES | wallet | retention |

La cuenta `Retenciones` esta como `wallet` en el catalogo operativo. No se cambia todavia porque `account_kind` tambien participa en reglas de pago y visibilidad. En su lugar, se crea un perfil de cierre separado con `closure_kind = retention`.

## Paso 1: perfiles de cierre

Archivo:

```text
docs/FINANCIAL_ACCOUNT_CLOSURE_PROFILES_2026-06-16.sql
```

Este SQL crea `money_account_closure_profiles` y carga un perfil para cada cuenta actual.

Ventajas:

- No altera `money_accounts`.
- No altera `money_movements`.
- No altera `payment_reports`.
- No altera cierres existentes.
- Permite que Finanzas use reglas canonicas sin romper la operacion actual.

## Paso 2: cierre linea base

Archivo:

```text
docs/FINANCIAL_ACCOUNT_BASELINES_2026-06-16.sql
```

Antes de cambiar la pantalla de cierres, cada cuenta debe poder tener un cierre de linea base.

La linea base debe registrar:

- cuenta
- fecha/hora del corte
- saldo real introducido por master/admin
- saldo esperado del sistema
- diferencia inicial clasificada
- usuario
- notas

Desde esa linea base, el siguiente cierre ya no debe sumar toda la historia desde cero. Debe calcular:

```text
saldo final del cierre anterior
+ entradas confirmadas del periodo
- salidas confirmadas del periodo
+/- pendientes heredados resueltos
= saldo esperado del nuevo cierre
```

La tabla `money_account_reconciliation_items` guarda diferencias abiertas, resueltas o anuladas. Esto permite que una diferencia de un cierre anterior no desaparezca, sino que se arrastre hasta ser identificada o corregida formalmente.

## Paso 3: diferencias clasificadas

Agregar una tabla de diferencias por cierre para que cada monto quede explicado.

Tipos canonicos:

- `unidentified_payment`
- `unregistered_fee`
- `unregistered_transfer`
- `conversion_difference`
- `amount_error`
- `timing_difference`
- `manual_adjustment`
- `other_pending`

Regla:

```text
diferencia del cierre
- diferencias clasificadas
= pendiente sin explicar
```

## Paso 4: pantalla por tipo de cuenta

La UI de cierre debe cambiar segun perfil:

- Banco: saldo real del banco, diferencia permitida si queda clasificada.
- Caja: conteo fisico, debe cerrar en cero o ajuste formal.
- Punto: debe cerrar en cero y vincular transferencia POS -> banco.
- Wallet USD: saldo USD, diferencia permitida por fee/conversion/pendiente.
- Retenciones: documentos recibidos, aplicados y pendientes.

## Paso 5: proteger historia y correcciones

Reglas de integridad:

- Un movimiento confirmado no se borra.
- Un cierre aprobado no se edita silenciosamente.
- Un error se corrige con anulacion, reapertura o cierre correctivo.
- Toda correccion deja actor, fecha, motivo, valor anterior y valor nuevo.

## Decision de implementacion

El siguiente paso tecnico recomendado es ejecutar primero el SQL de perfiles de cierre. Despues de confirmar que cada cuenta quedo perfilada correctamente, se implementa la pantalla de cierre usando `money_account_closure_profiles`.

Esto evita parchos porque separa dos conceptos:

- `account_kind`: como opera una cuenta en pagos y visibilidad.
- `closure_kind`: como se cierra y audita financieramente esa cuenta.
