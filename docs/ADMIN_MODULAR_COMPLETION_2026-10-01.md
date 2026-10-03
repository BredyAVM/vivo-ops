# Administración modular — corte del 1 de octubre de 2026

Revisiones adicionales del 2 y 3 de octubre de 2026. El administrador anterior continúa disponible. La configuración segura de cuentas y usuarios se instaló con autorización explícita el 3 de octubre; ambos administradores comparten los comandos de guardado.

## Alcance y decisión

Reemplazar gradualmente el panel administrativo de Master sin retirarlo todavía. Administración mantiene una navegación común y comparte los componentes y comandos operativos existentes. No se crea otra contabilidad, otra política de comisiones ni otro motor de jugadas.

La portada muestra indicadores y comparaciones; las áreas pesadas se consultan por separado. Las listas usan el número corto de orden, detalles progresivos, tipografía compacta, amarillo #FFFF00 y navegación contextual. La identidad de rol se verifica en el servidor y en las operaciones; la ruta visual no concede permisos.

## Matriz de cobertura

| Bloque | Recorrido en Administración | Estado del corte |
| --- | --- | --- |
| Navegación y marco común | Inicio, Operaciones, Finanzas y Negocio | Implementado; rutas y formularios compartidos permanecen dentro de Administración |
| Órdenes | /app/admin/ordenes | Conserva el tablero compartido y ajustes administrativos por permiso/estado; no se sustituyeron comandos de órdenes |
| Aprobaciones y seguimiento | /app/admin/autorizaciones | Aprobaciones separadas de incidencias; seguimiento por dominio y consulta explícita |
| Cuentas operativas | /app/admin/finanzas/cuentas | Ingresos, egresos, transferencias, cierre, conciliación y anulación conservan los comandos atómicos existentes |
| Reportes de pago de clientes | /app/admin/finanzas/pagos | Consulta explícita por período, estado y número corto; 25 reportes por página; revisión en el drawer compartido de la orden |
| Configuración de cuentas y usuarios | /app/admin/configuracion/cuentas y /usuarios | Guardado seguro habilitado por capacidades verificadas: cuentas/perfil de cierre, activación, permisos de pago, saldo inicial y usuarios; conserva el panel anterior |
| Tasa diaria | /app/admin/configuracion/tasa | Formulario nativo; mismo comando auditado existente; historial explícito y paginado |
| Análisis comercial | /app/admin/analisis | Consulta por período, canal, pickup/delivery y vendedor; neto, cierres, abonado y pendiente; CSV del filtro |
| Comisiones y metas | /app/admin/finanzas/comisiones y /operar | Reutiliza cálculo, cierres, pagos y metas existentes; no duplica reglas o liquidaciones |
| Delivery | /app/admin/finanzas/delivery | Entrada sin histórico automático; conserva filtros, liquidaciones, extras, deducibles y abonos parciales |
| Empresas y tarifas | /app/admin/configuracion/delivery | Formularios nativos que reutilizan comandos existentes; tarifas paginadas por empresa |
| Catálogo e inventario | /app/admin/inventario | Configuración, productos, recetas, entradas, conteos, ajustes, alertas y reportes compartidos; precios en lista nativos |
| Jugadas y eventos | /app/admin/jugadas y /app/admin/eventos | Entradas bajo consulta; operación compartida con el marco administrativo |
| Clientes | /app/admin/configuracion/clientes y /app/admin/clientes/[id] | Alta/edición completa con comandos existentes; ficha comercial consultada por separado |
| Notificaciones | /app/admin/notificaciones | Panel compartido del dispositivo; no activa avisos ni envía pruebas automáticamente |
| Auditoría | /app/admin/reportes/ajustes | Ajustes de órdenes por fecha/orden/responsable; historial privado de configuración disponible por consulta, con actor/antes/después |
| KPIs y proyecciones | Inicio y /app/admin/proyecciones | Conserva indicadores compactos, comparación semanal y escenarios; no incorpora costos inexistentes como rentabilidad real |

La matriz distingue implementación de verificación de escrituras reales. Las acciones monetarias, el alta de usuarios y las operaciones físicas NO se ejecutaron contra registros reales para probar esta entrega.

## Carga y límites

- No se monta MasterDashboardClient desde las nuevas áreas de configuración.
- Entradas frías de inventario, jugadas, eventos, análisis, clientes, seguimiento y delivery no consultan el historial completo.
- Cada área consulta al entrar o al pulsar Consultar según su recorrido. No hay precarga automática de todos los dominios ni prefetch de enlaces operativos.
- La portada ya no ejecuta la consulta comercial financiera que no utilizaba. Conserva las consultas necesarias de tesorería, posición e indicadores; no equivale a cero consultas al entrar.
- Los saldos de órdenes de la portada se leen en lotes de 250, con hasta cuatro lecturas simultáneas. Una respuesta incompleta, duplicada o fuera de la selección falla explícitamente; no se reemplaza una deuda desconocida por cero.
- Confirmaciones y anulaciones financieras compartidas invalidan también el marco de Administración. No se agregó sondeo continuo ni se promete sincronización instantánea entre navegadores: Actualizar vuelve a consultar.
- Pagos de clientes no lee reportes al entrar sin Consultar. Usa fecha de operación, o fecha de registro en Caracas cuando falta, y paginación estable de 25 más centinela. No calcula un total global de pagos ni sustituye la cobranza.
- Configuración e historial: páginas de 25 registros más centinela. Clientes: primeros 20 resultados; refinar búsqueda.
- Análisis: hasta un año por consulta, menos de 1.000 resultados por consulta de origen. Al alcanzar un límite se pide refinar; no se presentan totales parciales.
- Pagos puntuales/tardíos y clientes nuevos son consultas adicionales explícitas. Pagos: máximo 500 órdenes seleccionadas. Historial de nuevos clientes se limita a los clientes de la selección, con paginación y corte de importación vigente.
- El neto comercial excluye impuesto; abonado y pendiente son los saldos financieros actuales de la orden completa. No se restan importes redondeados para reconstruir una deuda.
- La comisión del análisis es una estimación: conserva reglas fechadas y ajustes, con porcentaje general indicado por el usuario. No cierra ni paga una liquidación.
- Precios en lista reutiliza el comando vigente, que guarda productos individualmente. Ante error se advierte que puede haber cambios parciales y debe consultarse de nuevo antes de repetir. No se promete atomicidad de ese comando legado.
- El alta de clientes conserva sus campos personales, fiscales, de entrega, direcciones recientes y etiquetas; no escribe fondos o saldos desde el formulario.

## Configuración segura — instalada el 3 de octubre de 2026

Implementación canónica: supabase/migrations/20261003171627_admin_configuration_atomic.sql. La versión coincide con el registro real de Supabase; el archivo fue generado inicialmente con la CLI y alineado después con la versión devuelta por la instalación. La propuesta histórica conserva únicamente un enlace a esta implementación, no una segunda copia ejecutable.

La instalación anterior se mantuvo bloqueada hasta recibir autorización específica. El usuario la otorgó el 3 de octubre; se instaló mediante apply_migration después de las pruebas aisladas. Se añadieron seis funciones públicas autenticadas, una comprobación privada de autorización y una tabla privada de auditoría. No se revocaron permisos globales ni se cambió la configuración de Auth.

Las cuentas/perfil de cierre, permisos de pago, línea base y perfil/roles se guardan transaccionalmente, con actor/antes/después. Cuentas, reglas y línea base conservan identidad de reintento. La activación utiliza un comando limitado que no reemplaza otros campos de la cuenta. Se rechazan solicitudes reutilizadas con otros datos, reglas inválidas, cambios de moneda/tipo existentes y la pérdida del acceso administrativo propio.

Una consulta de capacidades autenticada habilita los formularios solo con la versión esperada. Si falta o falla, no hay escritura alternativa parcial ni alta de Auth. Las cinco entradas de configuración del Administrador anterior delegan ahora a los mismos comandos canónicos: crear/editar cuenta, permisos de pago, línea base y perfil/roles. El panel anterior no fue retirado. Master conserva su permiso previo de línea base mediante el RPC autorizado por sesión, sin recibir acceso administrativo a cuentas o usuarios.

Seguridad y concurrencia verificadas:

1. PostgreSQL nativo en un clúster temporal, solo loopback, con sesiones independientes y datos sintéticos: reintento simultáneo sin duplicar cuenta/auditoría, payload contradictorio, reglas serializadas, activación tras edición sin perder campos y una sola línea base activa. No utiliza conexión ni credenciales de producción.
2. Administrador revocado o desactivado mientras espera: debe rechazarse al continuar. Dos administradores que intentan retirarse mutuamente no eliminan ambos accesos. Se vuelve a verificar la autorización después de la espera.
3. Las escrituras requieren READ COMMITTED, aislamiento normal de la aplicación comprobado en producción. REPEATABLE READ/SERIALIZABLE se rechazan explícitamente para no autorizar con una fotografía persistente de roles ya revocados.
4. Se verificaron firmas, search_path vacío y grants en producción: anónimos/PUBLIC/service_role sin EXECUTE; authenticated con EXECUTE y comprobación interna de rol/perfil. Tabla privada con RLS y sin acceso directo para esos roles.
5. Llamadas de lectura en transacciones read-only: anónimo rechazado por permisos; asesor rechazado por rol; administrador obtiene capacidades y consulta del historial. Las pantallas de cuentas y usuarios quedaron habilitadas en la sesión administrativa, sin enviar formularios.
6. Antes/después: 16 cuentas, 15 perfiles de cierre, 107 reglas, 16 líneas base, 16 perfiles y 28 roles; sin cambios. Nueva auditoría vacía: no se crearon operaciones reales para comprobar el circuito. Los asesores de seguridad mantuvieron los seis avisos previos, sin nuevos avisos introducidos por esta instalación.

Verificación del bloque: 605 pruebas .mts, 68 pruebas adicionales de PWA/precios/comisiones PostgreSQL aisladas y 12 comprobaciones del harness de concurrencia nativa; sin fallos ni omisiones en las ejecuciones configuradas. Compilación de producción y lint del alcance nuevo aprobados. La concurrencia usa un esquema sintético con los tipos/restricciones inspeccionados; no certifica todos los casos futuros ni hace pruebas de carga contra producción. Auth y PostgreSQL no comparten transacción: el alta compensa únicamente el usuario recién creado cuando falla la configuración; esa compensación se probó de forma simulada, sin crear usuarios reales.

## Verificación de aplicación

- Regresión conjunta: Admin, comisiones, seguridad, Master Ops y CRM.
- Nuevos casos ejecutan los lectores y acciones reales con sesión/base simuladas: entrada fría, paginación, tarifas de páginas posteriores, rechazo por rol, bloqueo cuando no existe migración, identidad de reintento, normalización de reglas y compensación limitada al ID recién creado de Auth.
- Compilación de producción y lint del alcance nuevo.
- 511 pruebas aprobadas en la regresión conjunta de la revisión del 2 de octubre, sin fallos, incluida una prueba PostgreSQL aislada con múltiples comprobaciones.
- Publicación de configuración: 15bc31f; análisis y precios: 3d0abaf. Ambos despliegues confirmados por Vercel y rutas comprobadas en producción.
- Navegador con sesión Admin: consulta de períodos/liquidaciones dentro del marco, tasa e historial con actor/fecha/valores, configuración de cuentas y bloqueo de edición pendiente, ficha comercial de cliente y análisis del 7 al 13 de septiembre con pagos puntuales/tardíos.
- Comprobación de anchura: 1280 px de escritorio y 375 px de móvil, sin desbordamiento de documento en los recorridos verificados de análisis, cuentas y ficha de cliente. No certifica todos los estados posibles de cada formulario.
- La prueba de compensación es simulada: no se creó ni eliminó ningún usuario real.
- La propuesta se ejecutó en PostgreSQL aislado en memoria con PGlite y un esquema sintético vacío basado en los tipos y restricciones inspeccionados. Se comprobaron rechazo de anónimos/asesores, reintentos sin doble auditoría, rechazo de payload distinto, inmutabilidad de moneda, rollback tras fallo tardío, reglas, roles, protección del acceso propio, línea base con movimientos confirmados e historial privado. Ningún caso escribió datos de producción. La prueba no equivale a la instalación ni a una prueba de contención entre sesiones.
- Revisión de operaciones en producción sin enviar formularios: egreso desde C.CH Dark $ conserva cuenta/tipo y retorno; cierre conserva cuenta y distingue saldo observado de salida de efectivo; un pago confirmado muestra acceso a anulación. En móvil de 375 px, el detalle no desborda el documento. Esto verifica acceso y presentación, no una anulación real.
- Pagos publicados y comprobados: entrada fría, consulta del 7 al 13 de septiembre, 25 resultados por página, segunda página con el filtro intacto y apertura de una orden histórica en Pagos. La portada y pagos se comprobaron a 1280 y 375 px, sin desbordamiento horizontal de documento. La comparación adicional de cierres abre con datos ya consultados.
- La revisión detectó enlaces de Eventos e Inventario del tablero compartido que todavía salían de Administración. Se corrigieron con la navegación contextual compartida, sin cambiar los destinos operativos de Master ni conceder permisos nuevos.
- Se corrigió la etiqueta del tablero de órdenes: su cálculo existente suma totales con impuesto y ahora dice Facturación, no Fact. neta. La portada conserva el neto comercial sin impuesto. No se cambiaron importes guardados. La agregación del tablero todavía redondea por orden, mientras la portada conserva la precisión financiera; se debe auditar esa diferencia antes de unificar cálculos compartidos.
- Conceptos antiguos que contienen un rastreador VO se presentan con el número corto de la orden vinculada. No se deduce el número de la parte final del rastreador ni se modifica el concepto guardado. Si no existe vínculo, se indica orden sin vínculo.

## Seguridad de dependencias — revisión del 3 de octubre de 2026

La revisión anterior reportó 14 paquetes señalados: uno crítico, nueve altos, tres moderados y uno bajo. Ese resultado era un corte histórico, no el estado actual. La nueva consulta del 3 de octubre encontró 19 antes de actualizar. Los conteos de npm son entradas de paquetes y pueden repetir una misma vulnerabilidad a través de su cadena de dependencias; no equivalen a 19 fallas explotables comprobadas.

| Consulta del 3 de octubre | Antes | Después |
| --- | --- | --- |
| Dependencias de producción (`npm audit --omit=dev`) | 5: 1 crítica, 3 altas, 1 moderada | 0 alertas |
| Árbol completo (`npm audit`) | 19: 1 crítica, 14 altas, 3 moderadas, 1 baja | 5 altas, todas de la misma cadena de herramientas de desarrollo |

Next.js pasó de 16.2.6 a 16.3.8, junto con eslint-config-next 16.3.8. React y React DOM permanecen en 19.2.3; no se cambiaron Supabase, reglas de negocio, rutas operativas, inventario ni registros financieros. El lockfile incorpora las correcciones compatibles de dependencias transitivas. No se usó `npm audit fix --force`, ni se degradó el framework o sus herramientas a otra versión principal.

Fuentes del framework: [release de Next.js 16.3.8](https://github.com/vercel/next.js/releases/tag/v16.3.8) y [aviso crítico de next/og](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j). La búsqueda en src y scripts no encontró uso de next/og o ImageResponse; no se declara que esa vía crítica estuviera siendo explotada. Se actualizó también por los demás avisos aplicables al paquete.

**Riesgo residual explícito:** eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces 3.0.3. Son dependencias marcadas como desarrollo en el lockfile. El [aviso GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) no tiene versión corregida disponible en este corte. No se aceptan patrones de búsqueda externos para esas herramientas desde la aplicación; no se encontró importación en src o scripts. Esto acota su exposición, pero no corrige el paquete. Debe volver a comprobarse al actualizar las herramientas; no debe ejecutarse tooling sobre configuraciones o patrones no confiables. No se creó una excepción silenciosa ni se reemplazó el paquete por un parche propio.

La compilación de Next.js 16.3 incluye el proyecto TypeScript completo, haciendo visibles errores previos de tipos en harnesses de pruebas (incluido registerHooks de Node moderno frente a tipos de Node 20). tsconfig.build.json separa esos harnesses y outputs de la compilación de aplicación, manteniendo strict y todos los controles de producción, sin ignoreBuildErrors. tsconfig.json conserva las comprobaciones del editor; la deuda de tipos de esos harnesses queda pendiente y sus pruebas se ejecutan por separado. AGENTS.md apunta a la documentación incluida con la versión instalada, siguiendo la guía del framework.

Verificación de este bloque: compilación de producción con Next.js 16.3.8 y revisión estricta de TypeScript aprobadas; 602 pruebas .mts, incluidas cinco nuevas comprobaciones del lockfile/configuración, y 68 pruebas adicionales de PWA y comandos PostgreSQL aislados de precios/comisiones; sin fallos ni omisiones. El lint del alcance cambiado pasó. La revisión local verificó login visible, ausencia de overlay/errores de consola y redirección de una ruta administrativa sin sesión; no se enviaron formularios de negocio ni notificaciones reales. Los resultados de audit son del corte señalado y no garantizan ausencia de futuras alertas.

La consulta de asesores de seguridad de la base también conserva advertencias previas de funciones privilegiadas, permisos y protección de contraseñas. No se aplicaron revocaciones globales ni cambios de Auth. Estos hallazgos necesitan revisión específica y no permiten declarar que toda la aplicación esté libre de vulnerabilidades.

## Coherencia de indicadores — 3 de octubre de 2026

Inicio y el tablero compartido de Órdenes usan ahora el mismo agregador puro
`src/lib/orders/operational-kpis.ts`. Se conserva la precisión de los importes
canónicos para sumar; se redondea a dos decimales una vez al presentar cada
total. El DTO separado `kpiAmounts` es exclusivamente de lectura: no modifica
los importes usados por formularios, movimientos, cobros ni liquidaciones.
Los snapshots y funciones de escritura de precios/comisiones no se cambiaron.

Órdenes muestra separadamente **Total con impuesto** y **Fact. neta**. La primera
es el total canónico de la obligación; la segunda es el neto comercial del
snapshot después de descuentos y sin impuesto, como Inicio. Abonado son los
pagos confirmados de las órdenes del período, no las entradas a cuentas del día.
No se fuerza la igualdad neto = abonado + pendiente: tienen bases distintas,
puede haber crédito aplicado, cambios, impuestos y cierres por redondeo.

El saldo canónico decide si hay deuda. Una marca histórica de cierre por
redondeo no reemplaza un saldo positivo posterior a una modificación autorizada.
Esto corrige un supuesto del lector anterior; no reabre ni cierra órdenes en
la base. La deuda por cambio excesivo tampoco se limita al precio de la orden:
se conserva el saldo canónico completo, aunque la cobertura se limite al precio.
Los lectores rechazan importes nulos, vacíos, no finitos, negativos,
respuestas incompletas, duplicadas o ajenas al conjunto solicitado. La ausencia
de datos no se convierte en una orden totalmente cubierta.

Los gráficos operativos y financieros acumulan valores no redondeados entre
días y semanas. Las referencias y los promedios de cierres también conservan
precisión interna, evitando diferencias al terminar la línea. El gráfico
operativo no observa días futuros, aunque la tarjeta semanal sí incluye órdenes
programadas para el resto de la semana, según su contrato vigente.

Cobranzas declara fecha de creación/entrega y conserva la consulta explícita
por filtros y todas las páginas. **Pagos aplicados** sustituye la etiqueta
ambigua «Abonado / cubierto»: es el pago confirmado limitado al total de la
orden, según el lector SQL existente; no sustituye pendiente ni incorpora por
su cuenta fondos del cliente. Comisiones dice **Por pagar a asesores** y mantiene
los cierres guardados, sin reconstruirlos como deuda actual del cliente.

Auditoría read-only de la semana 28/09–04/10: muestra SQL de 113 órdenes en
estados distintos de creada/cancelada, antes del filtro de valor del KPI; neto
comercial del snapshot USD 3.775,49, total canónico USD 3.820,12 y pagos
confirmados USD 3.127,84. Pendiente agregado canónico USD 692,23 frente a
USD 692,24 al redondear cada orden. Había 23 órdenes con fracciones internas;
ninguna tenía saldo positivo junto a la marca histórica de redondeo en esta
muestra. Son cifras al corte de la consulta, no constantes de la aplicación.
No se cambiaron datos comerciales ni se realizaron operaciones financieras.
La selección SQL no certifica el mismo conjunto de las tarjetas por sesión y
fecha de corte; su propósito es comprobar el efecto aritmético del redondeo.

Verificación: regresiones para impuestos/descuentos, fracciones entre días,
gráfico frente a total semanal, crédito y deuda por cambio excesivo, estados
creado/cancelado/obsequio, datos inválidos, lectura de batches y cierre
histórico seguido de precio ajustado. No se agregaron consultas, sondeo,
precarga de históricos ni dependencias.
La regresión completa tiene 614 pruebas .mts aprobadas y compilación estricta
de producción aprobada. Lint aprobado para el módulo nuevo, lectores ejecutivos
y componentes de cobranza/comisiones; el cargador compartido conserva cuatro
`any` previos al bloque, constatados contra HEAD, no introducidos por el cambio.

## Fuera de este corte

Estructuras de costos, valoración económica del inventario, nómina, rentabilidad y proyecciones basadas en costos reales necesitan sus fuentes y metodología. No se deducen del saldo de cuentas ni se muestran como datos ya existentes.

La importación de extractos y un historial agregado incremental de cobranza tampoco se han implementado. La cobranza sigue siendo por filtro explícito, sin escanear todo el histórico al entrar.

El panel antiguo continúa disponible hasta completar y verificar la cobertura operativa pendiente.
