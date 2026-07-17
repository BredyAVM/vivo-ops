# Politica operativa de datos y frescura - VIVO Ops

Fecha: 2026-07-17

Este documento define como debe cargarse, refrescarse y cachearse la informacion en VIVO Ops por modulo y por tipo de dato.

La meta es equilibrar tres necesidades:

1. evitar espejismos operativos o financieros;
2. reducir invocaciones y CPU en Vercel;
3. mantener pantallas rapidas, enfocadas y sostenibles.

Regla central:

```text
Cada modulo debe cargar solo la informacion necesaria para su trabajo operativo.
Los datos criticos se consultan frescos.
Los datos estables se cachean o se cargan bajo demanda.
```

## 1. Tipos de datos

### 1.1 Datos vivos

Son datos que cambian durante la operacion y pueden causar errores si se ven viejos.

Ejemplos:

- ordenes activas;
- estado de cocina;
- estado de entrega;
- pagos pendientes o confirmados;
- saldo operativo de caja/punto/banco;
- cierres y conciliaciones;
- notificaciones/acciones pendientes.

Regla:

- deben consultarse frescos cuando la pantalla los necesita;
- pueden refrescarse por accion del usuario, polling ligero, realtime o push;
- no deben depender de cache persistente del navegador si afectan decisiones.

### 1.2 Datos bajo demanda

Son datos importantes, pero no necesarios todo el tiempo.

Ejemplos:

- detalle historico de una cuenta;
- auditoria de movimientos;
- historial largo de ordenes;
- conciliaciones anteriores;
- reportes de comisiones;
- busquedas por cliente, telefono u orden.

Regla:

- no deben cargarse al abrir la pantalla principal;
- se cargan al presionar buscar, abrir detalle o generar reporte;
- deben ser frescos al momento de consulta.

### 1.3 Datos estables o semi-estables

Son datos que cambian poco y no causan dano inmediato si se cargan desde cache durante un periodo corto.

Ejemplos:

- catalogo de productos activos;
- componentes de productos;
- metodos de pago;
- reglas de permisos;
- perfiles de usuarios;
- tasa activa, con cuidado operativo;
- listas de cuentas activas.

Regla:

- pueden cachearse por modulo o por sesion;
- deben invalidarse cuando se editen desde administracion;
- si afectan precios o cobros, la accion final debe validar contra servidor fresco.

## 2. Principio por pantalla

Cada pantalla debe responder una pregunta clara.

```text
Pantalla operativa: que tengo que hacer ahora?
Pantalla administrativa: que debo revisar, aprobar o conciliar?
Pantalla historica: que paso y como lo audito?
```

Una pantalla operativa no debe cargar reportes historicos pesados.

Una pantalla administrativa no debe vivir refrescando datos operativos que no se estan revisando.

Una pantalla historica debe cargar bajo demanda, con filtros claros.

## 3. Politica por modulo

## 3.1 Master operativo

Objetivo:

- coordinar pedidos;
- aprobar o devolver ordenes;
- enviar a cocina;
- asignar delivery;
- confirmar/rechazar pagos cuando aplica;
- resolver acciones urgentes.

Datos vivos:

- ordenes del dia operativo o rango seleccionado;
- acciones pendientes;
- seguimiento relevante;
- pagos por confirmar;
- estado de cocina y delivery;
- notificaciones push o internas.

Datos bajo demanda:

- detalle completo de cuenta;
- movimientos financieros largos;
- auditoria historica;
- reportes administrativos;
- cierres y conciliaciones.

Datos cacheables:

- catalogo;
- usuarios activos;
- metodos de pago;
- reglas de visualizacion.

Regla:

```text
Master debe ver operacion fresca, no finanzas pesadas por defecto.
```

## 3.2 Administracion

Objetivo:

- revisar finanzas;
- aprobar movimientos;
- conciliar cuentas;
- cerrar periodos;
- revisar comisiones;
- controlar usuarios/permisos.

Datos vivos:

- saldos de cuentas cuando se abre la vista de cuentas;
- pagos por aprobar;
- movimientos pendientes;
- cierres/conciliaciones abiertos;
- snapshots financieros.

Datos bajo demanda:

- movimientos filtrados por cuenta;
- auditoria de una cuenta;
- reportes por periodo;
- comisiones por asesor;
- detalle de conciliaciones.

Datos cacheables:

- catalogo;
- usuarios;
- reglas de cuentas;
- metodos de pago.

Regla:

```text
Administracion no debe cargar todo siempre; debe consultar fresco cuando abre una vista financiera o genera un reporte.
```

## 3.3 Counter / mostrador

Objetivo:

- entregar pickup;
- entregar pedido a motorizado;
- liquidar retorno de delivery;
- cobrar en caja/punto/efectivo;
- crear venta directa;
- cerrar caja/punto operativo.

Datos vivos:

- pedidos listos para pickup/delivery;
- pedidos en cocina consultables;
- pedidos en camino pendientes de liquidar;
- saldos de caja DAR y puntos;
- pagos de la orden seleccionada;
- cierres operativos recientes.

Datos bajo demanda:

- busqueda en agenda general por numero, cliente o telefono;
- detalle historico de cuenta;
- cierres anteriores;
- auditoria.

Datos cacheables:

- catalogo de productos;
- componentes de productos;
- metodos de pago;
- reglas de caja/punto.

Regla:

```text
Counter es una caja registradora operativa, no un dashboard financiero.
Debe ver solo lo necesario para cobrar, entregar y cerrar su caja/punto.
```

## 3.4 Cocina

Objetivo:

- tomar pedidos;
- asignar ETA;
- preparar comandas;
- marcar listo;
- reportar retrasos/incidencias.

Datos vivos:

- pedidos en cola;
- pedidos en preparacion;
- tiempo restante;
- incidencias activas;
- notificaciones fuertes de nueva cola.

Datos bajo demanda:

- detalle extendido historico;
- inventario/averias cuando se implemente formalmente;
- impresion/reimpresion.

Datos cacheables:

- configuracion minima de productos;
- reglas de comanda;
- metadatos de preparacion cuando existan.

Regla:

```text
Cocina debe cargar solo comandas activas. No debe arrastrar datos financieros.
```

## 3.5 Asesor

Objetivo:

- crear pedidos;
- cotizar;
- modificar antes de cocina;
- reportar pagos;
- dar seguimiento a sus ordenes;
- revisar notificaciones y acciones.

Datos vivos:

- sus acciones pendientes;
- estado de sus ordenes activas;
- pagos rechazados/aprobados;
- notificaciones.

Datos bajo demanda:

- busqueda historica de ordenes;
- detalle de una orden;
- borradores/cotizaciones;
- reportes de periodo y comisiones.

Datos cacheables:

- catalogo;
- componentes;
- perfil del asesor;
- datos frecuentes de clientes, con validacion server al guardar.

Regla:

```text
Asesor puede cachear ayuda para vender rapido, pero al crear/modificar debe validar precios, tasa y permisos en servidor.
```

## 3.6 Driver / motorizado

Objetivo:

- ver pedidos asignados;
- navegar direccion/GPS;
- contactar cliente;
- marcar estados;
- reportar incidencia;
- registrar cobro/cambio cuando aplique.

Datos vivos:

- pedidos asignados activos;
- direccion/GPS;
- contacto;
- estado de cobro/cambio;
- incidencias.

Datos bajo demanda:

- historial de entregas;
- pagos anteriores;
- auditoria.

Datos cacheables:

- perfil del driver;
- configuracion de vista.

Regla:

```text
Driver debe ver solo lo asignado a el y lo necesario para entregar.
```

## 4. Reglas de actualizacion

### 4.1 Refresco automatico

Se permite en pantallas donde el trabajo depende de eventos en vivo:

- master operativo;
- cocina;
- counter operativo;
- advisor inbox.

Debe ser ligero:

- refrescar listas resumidas, no detalles pesados;
- evitar polling demasiado frecuente;
- usar push/realtime para avisar y refrescar solo cuando haga falta.

### 4.2 Refresco manual

Debe existir donde el usuario necesita garantizar la foto actual:

- cuentas;
- saldos;
- cierres;
- conciliaciones;
- pagos por aprobar;
- detalle de orden sensible.

El boton debe indicar claramente que vuelve a consultar la verdad del servidor.

### 4.3 Busqueda bajo demanda

Se usa para:

- buscar orden fuera de la vista actual;
- buscar cliente;
- explorar movimientos;
- generar reportes;
- consultar agenda historica.

Regla:

```text
No cargar listas enormes por si acaso. Buscar cuando el usuario pregunte.
```

## 5. Impacto en Vercel

La mayor fuente de consumo en este proyecto sera normalmente:

- invocaciones de funciones;
- CPU activa de funciones;
- consultas server-side repetidas;
- pantallas dinamicas que cargan demasiadas tablas.

Para reducir consumo sin romper la operacion:

1. separar pantallas operativas de pantallas administrativas;
2. evitar que una pantalla cargue datos que no muestra;
3. cargar historicos bajo demanda;
4. usar snapshots para saldos y estados costosos;
5. cachear catalogos y configuraciones estables;
6. refrescar listas resumidas, no detalles completos;
7. mover calculos pesados a funciones canonicas o snapshots cuando sea necesario.

## 6. Reglas canonicas de no regresion

1. Ninguna pantalla debe mostrar saldo financiero basado en cache viejo.
2. Ninguna pantalla debe calcular estado de pago con una regla local distinta.
3. Master, asesor, counter y admin deben leer el mismo estado financiero de una orden.
4. Counter y cocina no deben cargar reportes financieros pesados en su pantalla principal.
5. Administracion no debe depender de datos cacheados para saldos, cierres o conciliaciones.
6. Los catalogos pueden cachearse, pero la accion final de crear/modificar orden valida en servidor.
7. Las busquedas historicas deben ser bajo demanda.
8. Las notificaciones pueden avisar desde cache/realtime, pero la accion debe abrir datos frescos.
9. Cualquier cambio de politica de cache debe documentarse aqui.

## 7. Orden de implementacion recomendado

### Bloque 1 - Inventario de datos por pantalla

Crear una lista por modulo:

- que consulta al abrir;
- que consulta al refrescar;
- que consulta al buscar;
- que datos pueden cachearse.

### Bloque 2 - Separar master operativo de administracion

Mover gradualmente:

- cuentas;
- conciliaciones;
- cierres;
- reportes financieros;
- comisiones;
- auditoria.

Master conserva pedidos, pagos por aprobar y acciones urgentes.

### Bloque 3 - Optimizar counter

- pedidos vivos ligeros;
- caja/puntos frescos al abrir panel;
- cierres recientes bajo demanda;
- catalogo cacheable con validacion server.

### Bloque 4 - Optimizar cocina

- comandas activas vivas;
- sin datos financieros;
- incidencias operativas;
- inventario bajo demanda cuando exista.

### Bloque 5 - Snapshots y funciones canonicas

Usar snapshots para:

- saldos de cuentas;
- cierres/conciliaciones;
- resumen financiero de orden;
- reportes por periodo.

### Bloque 6 - Medicion

Revisar Vercel Usage por:

- Function Invocations;
- Active CPU;
- rutas mas costosas;
- frecuencia de refresh;
- errores/timeouts.

La optimizacion debe basarse en uso real, no solo intuicion.

