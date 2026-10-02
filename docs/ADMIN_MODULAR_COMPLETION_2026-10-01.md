# Administración modular — corte del 1 de octubre de 2026

Revisión adicional del 2 de octubre de 2026. El administrador anterior continúa disponible. La configuración privilegiada nueva todavía no está instalada en producción; no debe retirarse la alternativa anterior.

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
| Configuración de cuentas y usuarios | /app/admin/configuracion/cuentas y /usuarios | Consulta implementada; NUEVO GUARDADO BLOQUEADO hasta instalar y verificar la propuesta segura |
| Tasa diaria | /app/admin/configuracion/tasa | Formulario nativo; mismo comando auditado existente; historial explícito y paginado |
| Análisis comercial | /app/admin/analisis | Consulta por período, canal, pickup/delivery y vendedor; neto, cierres, abonado y pendiente; CSV del filtro |
| Comisiones y metas | /app/admin/finanzas/comisiones y /operar | Reutiliza cálculo, cierres, pagos y metas existentes; no duplica reglas o liquidaciones |
| Delivery | /app/admin/finanzas/delivery | Entrada sin histórico automático; conserva filtros, liquidaciones, extras, deducibles y abonos parciales |
| Empresas y tarifas | /app/admin/configuracion/delivery | Formularios nativos que reutilizan comandos existentes; tarifas paginadas por empresa |
| Catálogo e inventario | /app/admin/inventario | Configuración, productos, recetas, entradas, conteos, ajustes, alertas y reportes compartidos; precios en lista nativos |
| Jugadas y eventos | /app/admin/jugadas y /app/admin/eventos | Entradas bajo consulta; operación compartida con el marco administrativo |
| Clientes | /app/admin/configuracion/clientes y /app/admin/clientes/[id] | Alta/edición completa con comandos existentes; ficha comercial consultada por separado |
| Notificaciones | /app/admin/notificaciones | Panel compartido del dispositivo; no activa avisos ni envía pruebas automáticamente |
| Auditoría | /app/admin/reportes/ajustes | Ajustes de órdenes por fecha/orden/responsable; nuevo historial de configuración depende de la instalación pendiente |
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

## Instalación segura pendiente: no aplicada

Propuesta: docs/proposals/admin_configuration_atomic.NOT_APPLIED.sql.

La revisión de seguridad impidió instalar cambios privilegiados en producción sin autorización específica. No se burló ese bloqueo y no se agregó el archivo a migrations, para evitar su ejecución automática futura.

La propuesta prepara cuentas/perfil de cierre, permisos de pago, línea base y perfil/roles de usuario como operaciones transaccionales, con registro de actor/antes/después. Las operaciones de cuentas conservan identidad de reintento; los permisos financieros rechazan filas inválidas, cambios de moneda/tipo existentes y la pérdida del acceso administrativo propio.

Una consulta de capacidades autenticada habilita los nuevos formularios solo cuando la instalación existe y responde con la versión esperada. Si falta o falla, la interfaz y la acción de servidor bloquean el guardado antes de escribir. Alta de Auth también se bloquea antes de crear un usuario. Se conservan sin sustituir las cinco funciones originales de configuración de cuentas, reglas, línea base y usuarios en Administrador anterior.

Pendientes necesarios para dar ESTE bloque por terminado:

1. Obtener autorización explícita para la instalación en producción.
2. Completar la verificación de concurrencia real entre sesiones. Las pruebas transaccionales aisladas de permisos, reintentos, fallo al final de operación y ausencia de escrituras parciales ya pasaron; no certifican todas las condiciones concurrentes de producción.
3. Instalar mediante el mecanismo autorizado; verificar firmas, search_path y grants.
4. Comprobar llamadas anónimas/roles no autorizados y la consulta de capacidades.
5. Habilitar formularios y reemplazar las cinco rutas legadas solo tras verificar equivalencia. No ejecutar cambios reales para demostrar el circuito.

No se declara terminada ni activada esa parte mientras falten esos pasos.

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
- Conceptos antiguos que contienen un rastreador VO se presentan con el número corto de la orden vinculada. No se deduce el número de la parte final del rastreador ni se modifica el concepto guardado. Si no existe vínculo, se indica orden sin vínculo.

## Seguridad pendiente detectada en la revisión

La revisión de dependencias reportó 14 alertas: una crítica, nueve altas, tres moderadas y una baja. Next.js 16.2.6 aparece entre las dependencias directas afectadas. Debe verificarse la aplicabilidad de los avisos y actualizarse en un bloque de seguridad con regresión y despliegue propios; no se ejecutó una actualización automática general en esta entrega. La incorporación de PGlite es solo para pruebas y no aparece entre los paquetes señalados.

La consulta de asesores de seguridad de la base también conserva advertencias previas de funciones privilegiadas, permisos y protección de contraseñas. No se aplicaron revocaciones globales ni cambios de Auth. Estos hallazgos necesitan revisión específica y no permiten declarar que toda la aplicación esté libre de vulnerabilidades.

## Fuera de este corte

Estructuras de costos, valoración económica del inventario, nómina, rentabilidad y proyecciones basadas en costos reales necesitan sus fuentes y metodología. No se deducen del saldo de cuentas ni se muestran como datos ya existentes.

La importación de extractos y un historial agregado incremental de cobranza tampoco se han implementado. La cobranza sigue siendo por filtro explícito, sin escanear todo el histórico al entrar.

El panel antiguo continúa disponible hasta completar y verificar la cobertura operativa pendiente.
