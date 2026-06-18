# Manual operativo de cierres y conciliaciones financieras - VIVO Ops

Fecha: 2026-06-18

Este manual explica como iniciar y operar los cierres financieros desde el estado actual del sistema. Esta pensado para el equipo administrador y master.

La regla principal es simple:

```text
El sistema no borra historia financiera.
Si algo no cuadra, se deja como pendiente, ajuste, anulacion o resolucion con nota.
```

## 1. Conceptos basicos

### Linea base

La linea base es el punto de arranque de control de una cuenta.

Sirve para decir:

```text
Desde esta fecha, este es el saldo real inicial que vamos a tomar como referencia.
```

Se usa porque ya existia operacion antes de tener cierres formales. La linea base separa el pasado de lo que vamos a controlar desde ahora.

### Cierre

Un cierre compara:

```text
saldo esperado por el sistema
vs
saldo real contado o visto en banco
= diferencia
```

El cierre no debe usarse para inventar movimientos. El cierre documenta una posicion.

### Conciliacion

La conciliacion aplica principalmente a bancos y wallets.

Si el banco dice que hay un saldo distinto al sistema, el sistema deja una diferencia como pendiente:

- sobrante: hay mas dinero real que lo esperado
- faltante: hay menos dinero real que lo esperado

Ese pendiente se resuelve luego con nota, cuando se identifica la causa.

### Traspaso

Un traspaso mueve dinero entre cuentas internas del sistema.

Ejemplo:

```text
Punto BDV 1 -> BDV Juridico
```

No es una venta nueva. Es consolidar dinero que ya entro por otro medio.

## 2. Reglas por tipo de cuenta

| Tipo | Cuentas | Como se cierra |
| --- | --- | --- |
| Banco | BDV Juridico, BNC Juridico, BDV Bredy, Zelle VIVO, Zelle Ahorro | Con saldo final del banco. Puede cerrar con diferencia pendiente. |
| Caja | C.CH Dark BS, C.CH Dark $, C.CH Floresta Bs, C.CH Floresta $ | Con conteo fisico. Debe cuadrar. Si no cuadra, se corrige antes con ajuste formal. |
| Punto | Punto BNC, Punto BDV 1, Punto BDV 2 | Con el total del lote/punto. Debe cuadrar y genera traspaso automatico al banco destino. |
| Wallet USD | Binance, Paypal | Con saldo real en USD. Puede cerrar con diferencia pendiente por fee, conversion o monto no identificado. |
| Retenciones | Retenciones | Control documental. Se usa para saber retenciones recibidas, aplicadas y pendientes. |

## 3. Antes de empezar

Confirmar que existen estas piezas:

1. Perfiles de cierre creados para todas las cuentas.
2. Tabla de lineas base y pendientes de conciliacion creada.
3. Permisos/grants aplicados.
4. Puntos asociados a su banco destino.

En la pantalla:

```text
Master/Admin -> Config. -> Cuentas
```

Presionar `Actualizar` antes de iniciar.

## 4. Crear lineas base

Cada cuenta debe tener una linea base activa.

Ruta:

```text
Config. -> Cuentas -> abrir cuenta -> Cierres -> Linea base
```

Si la cuenta aparece como `Sin linea base`, crear una.

### Datos a colocar

| Campo | Que colocar |
| --- | --- |
| Fecha corte | Fecha desde la cual se inicia el control |
| Saldo real | Saldo visto o contado en ese momento |
| Tasa Bs/USD | Solo para cuentas VES |
| Motivo | `Linea base inicial` |
| Notas | Fuente del saldo: banco, conteo fisico, lote, wallet, documento |

Ejemplo de nota:

```text
Linea base inicial. Saldo tomado del banco BDV al cierre del 18/06/2026.
```

### Linea base por tipo de cuenta

#### Bancos

Usar el saldo real que muestra el banco en la fecha de corte.

No hace falta cargar cada movimiento del banco. Solo se fija la posicion inicial.

#### Cajas

Contar el efectivo fisico.

Ese monto es la linea base.

#### Puntos

Si el punto esta limpio, la linea base puede ser `0`.

Si hay un lote pendiente de consolidar, la linea base debe reflejar lo que realmente esta pendiente en ese punto.

#### Wallets USD

Usar saldo real en USD.

No hace falta separar USDT, Paypal balance, comisiones o conversiones en esta primera version. Se controla en USD operativo.

#### Retenciones

Usar el total de retenciones pendientes por aplicar, segun documentos administrativos.

## 5. Cierre diario o periodico por bancos

Ruta:

```text
Config. -> Cuentas -> abrir banco -> Cierres -> Conciliar cuenta
```

Proceso:

1. Abrir el banco real.
2. Ver el saldo final de la fecha que se quiere cerrar.
3. En VIVO Ops, colocar esa fecha como `Fecha`.
4. Colocar el saldo final real en `Monto contado`.
5. Colocar tasa si es cuenta VES.
6. Motivo sugerido: `Cierre diario bancario`.
7. Guardar.

Resultado:

- Si cuadra, queda cierre sin diferencia.
- Si no cuadra, queda un pendiente de conciliacion.

No se debe forzar el sistema para que cuadre. Si hay diferencia, se deja visible.

### Que hacer si aparece diferencia

Primero revisar:

- pagos que cayeron en banco pero no fueron reportados
- pagos reportados en otra fecha
- comisiones bancarias
- transferencias internas no registradas
- errores de monto o referencia
- pago duplicado o movimiento anulado

Cuando se identifique:

```text
Cierres -> Pendientes de conciliacion -> Resolver
```

Escribir una nota clara.

Ejemplos:

```text
Identificado como pago no reportado del cliente Maria Perez, referencia 123456.
```

```text
Diferencia corresponde a comision bancaria registrada posteriormente como egreso.
```

## 6. Cierre de cajas

Ruta:

```text
Config. -> Cuentas -> abrir caja -> Cierres -> Registrar cierre
```

Proceso:

1. Contar efectivo fisico.
2. Colocar fecha de corte.
3. Colocar monto contado.
4. Guardar cierre.

Regla:

```text
La caja debe cuadrar.
```

Si no cuadra, no se debe tapar la diferencia. Primero se debe registrar el ajuste formal o revisar movimientos.

Ejemplos de causas:

- cambio entregado no registrado
- ingreso manual no registrado
- gasto pagado desde caja no registrado
- error de conteo

## 7. Cierre de puntos

Ruta:

```text
Config. -> Cuentas -> abrir punto -> Cierres -> Registrar cierre
```

Proceso:

1. Tomar el lote/cierre del punto.
2. Ver total real del lote.
3. Colocar ese monto como `Monto contado`.
4. Verificar cuenta destino.
5. Guardar cierre.

Regla:

```text
El punto debe cuadrar con el sistema.
```

Si cuadra, el sistema hace dos cosas:

1. Registra el cierre del punto.
2. Genera el traspaso automatico desde el punto hacia el banco asociado.

Ejemplo:

```text
Punto BDV 1 cierra Bs 10.000
Salida: Punto BDV 1 - Bs 10.000
Entrada: BDV Juridico + Bs 10.000
```

Eso no es un ingreso nuevo. Es consolidacion.

Si el banco recibe menos por comision, esa diferencia se maneja en el banco o como gasto/comision, no duplicando ventas.

## 8. Cierre de wallets USD

Ruta:

```text
Config. -> Cuentas -> abrir wallet -> Cierres -> Conciliar cuenta
```

Proceso:

1. Revisar saldo real de la wallet en USD.
2. Colocar fecha de corte.
3. Colocar saldo real.
4. Guardar.

Si hay diferencia, puede quedar como pendiente por:

- fee
- conversion
- pago no identificado
- retiro no registrado
- diferencia temporal

## 9. Retenciones

Retenciones no se manejan como banco normal.

Entradas:

- retencion entregada por cliente
- documento fiscal recibido

Salidas:

- retencion aplicada contra impuestos

Por ahora, usar esta cuenta para controlar el saldo/documentos pendientes. Si algo no cuadra, dejar nota clara en cierre o pendiente.

## 10. Como resolver pendientes de conciliacion

Ruta:

```text
Cuenta -> Cierres -> Pendientes de conciliacion -> Resolver
```

Resolver significa:

```text
ya sabemos que era esta diferencia
```

No significa borrar el cierre ni desaparecer la historia.

Siempre escribir una nota clara:

- quien era el cliente
- referencia bancaria
- si fue comision
- si fue error corregido
- si se registro movimiento posterior

## 11. Que no se debe hacer

- No cambiar fechas para que cuadren artificialmente.
- No registrar un pago dos veces para tapar una diferencia.
- No crear ingresos nuevos cuando en realidad es un traspaso interno.
- No resolver pendientes sin nota.
- No usar fecha de confirmacion como fecha financiera del banco.
- No borrar o anular movimientos sin motivo claro.

## 12. Checklist diario recomendado

### Bancos

1. Revisar saldo final real.
2. Conciliar cuenta.
3. Revisar pendientes abiertos.
4. Resolver lo identificado.
5. Dejar pendientes no identificados visibles.

### Cajas

1. Contar efectivo.
2. Revisar cambios entregados y gastos.
3. Registrar cierre.
4. Si no cuadra, revisar antes de guardar.

### Puntos

1. Revisar lote del punto.
2. Registrar cierre del punto.
3. Confirmar que se genero traspaso al banco.
4. Revisar banco receptor.

### Wallets

1. Revisar saldo USD.
2. Conciliar.
3. Registrar o resolver fees/conversiones si aplican.

## 13. Frecuencia recomendada

| Cuenta | Frecuencia |
| --- | --- |
| Bancos principales | Diario |
| Bancos de bajo movimiento | Interdiario o semanal |
| Cajas | Diario o por turno |
| Puntos | Cada lote/cierre de punto |
| Wallets | Diario si tienen movimiento, semanal si no |
| Retenciones | Semanal o mensual segun administracion |

## 14. Resumen para el equipo

```text
Primero creamos linea base.
Luego cada cierre compara saldo real vs sistema.
Bancos y wallets pueden quedar con pendiente.
Cajas y puntos deben cuadrar.
Los puntos generan traspaso automatico al banco.
Las diferencias no se ocultan: se resuelven con nota.
```

