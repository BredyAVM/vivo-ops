# Asesor: solicitudes de clientes y jugadas

## Alcance

Base revisada: `3ae9613`. Next.js instalado: 16.2.6.

- Los enlaces individuales a fichas en Clientes y Jugadas usan `prefetch={false}`.
- Se conserva Link, sus destinos, filtros y `returnTo`, junto con el indicador de carga existente.
- Se mantienen las precargas del menu, los filtros y la paginacion.
- Contacto por WhatsApp, lanzamiento de jugada y seguimiento manual dejan de llamar a `router.refresh()` despues de una accion exitosa.
- `recordClientPlayFollowUpAction` conserva permisos, validaciones, RPC y revalidaciones de Clientes, Jugadas y la ficha. La respuesta de la accion actualiza los componentes de servidor y sus props; no se necesita una segunda solicitud explicita de refresco.
- El selector de beneficios ya utiliza ese mecanismo. No se modifica.
- No se cambian autenticacion, notificaciones, reglas de negocio ni base de datos.

Referencias: [prefetching](https://nextjs.org/docs/app/guides/prefetching) y [revalidatePath](https://nextjs.org/docs/app/api-reference/functions/revalidatePath).

## Evidencia y limites

El handoff reporta 1.034.812 invocaciones y 6 h 21 min de CPU en Vercel. Su captura de rutas estaba ordenada por CPU, mostraba solo la primera de cuatro paginas y no permite atribuir todo el consumo a este flujo.

La inspeccion confirma dos puntos de precarga masiva y tres llamadas explicitas de refresco tras una accion que ya revalida. No constituye una medicion de solicitudes HTTP ni del ahorro de CPU. La frontera loading.tsx puede limitar la profundidad de una precarga: no se asume que cada enlace ejecute toda la ficha.

Las fichas sin precarga comienzan a cargarse al abrirlas. Debe comprobarse la respuesta visual al toque en telefono y en red lenta.

## Validacion en linea

No levantar un servidor local para esta prueba. Usar despliegues identificados por commit, el mismo asesor, navegador, filtros y volumen de clientes. Para mutaciones, utilizar participaciones de prueba equivalentes; no volver a registrar contactos reales solo para medir.

1. Abrir Clientes con filtro, busqueda y pagina definidos. Recorrer la lista sin abrir fichas. Repetir en Jugadas.
2. Abrir una ficha y volver. Confirmar que se conservan busqueda, filtro, pagina y jugada seleccionada, y que hay respuesta visual al navegar.
3. Registrar contacto manual y por WhatsApp. Confirmar estado, intentos e historial sin recargar manualmente; al volver de WhatsApp deben verse los datos actualizados.
4. Copiar o abrir el mensaje de una jugada aun no lanzada. Confirmar el texto, el lanzamiento y los hitos anteriores. Abrirlo otra vez no debe volver a registrar el lanzamiento.
5. Guardar nota y programar seguimiento. Confirmar mensaje de exito, historial y fecha; volver a los listados y comprobar el estado actualizado.
6. Elegir un beneficio y confirmar que la seleccion y el texto de la jugada se actualizan.
7. Comprobar un error de validacion con datos de prueba: debe conservarse el mensaje y no mostrarse exito ni perderse el texto pendiente.
8. Confirmar que las alertas siguen llegando y que otro asesor no puede abrir una ficha ajena.

## Comparacion de consumo

En el panel Red del navegador, conservar el registro y usar el mismo estado de cache en ambas versiones. Separar solicitudes de documento, RSC, acciones POST, precargas y trafico Realtime. No compartir un HAR sin quitar cookies, credenciales y datos personales.

| Operacion | Antes | Despues | Comprobar |
| --- | --- | --- | --- |
| Recorrer Clientes sin abrir fichas | Pendiente | Pendiente | Precargas a clients/[id] originadas por las filas |
| Recorrer Jugadas sin abrir fichas | Pendiente | Pendiente | Precargas a clients/[id] originadas por las filas |
| Abrir ficha y volver | Pendiente | Pendiente | Solicitudes y tiempo hasta mostrar datos |
| Guardar seguimiento | Pendiente | Pendiente | POST y ausencia del refresco explicito posterior |
| Contactar o lanzar por WhatsApp | Pendiente | Pendiente | POST, actualizacion visual y ausencia del refresco explicito |

En Vercel, comparar produccion en ventanas de duracion y actividad semejantes, ordenar por invocaciones y revisar todas las paginas. Registrar invocaciones, CPU, numero de asesores activos y operaciones completadas. Separar los despliegues y excluir previews. Las consultas del layout, otras invalidaciones y notificaciones pueden seguir generando solicitudes legitimas.

No publicar un porcentaje de ahorro hasta completar esta comparacion. Si /login sigue alto, revisar trazas de redirecciones y renovacion de sesion antes de diagnosticar un bucle.

## Publicacion

La rama de trabajo al iniciar era `codex/admin-cash-operations-20260912`, siguiendo `origin/main`. No cambiar de rama ni incluir archivos ajenos. Antes de publicar, actualizar la referencia remota y comprobar que el commit parte de main sin commits adicionales pendientes. Para actualizar produccion desde esta rama se requiere un destino explicito `HEAD:main`; `git push origin HEAD` actualiza la rama de trabajo.

Compilar y revisar los archivos cambiados antes del commit. Registrar por separado la publicacion en GitHub, el estado del despliegue y la validacion movil: ninguno demuestra por si solo los otros dos.

## Comprobaciones de esta entrega

- ESLint sobre los cinco componentes: correcto.
- TypeScript del codigo de la aplicacion (`src`, `next-env.d.ts` y tipos generados de Next): correcto, con las opciones del proyecto y sin emitir archivos.
- Pruebas existentes de personalizacion de mensajes CRM: 3 correctas.
- TypeScript global encuentra errores en pruebas ajenas de administracion y comisiones (registerHooks y snapshots), sin diagnosticos en los componentes modificados. Esos archivos no se modifican en esta entrega.
- Compilacion local: bloqueada por la descarga de Geist y Geist Mono desde Google Fonts, tambien al repetir con acceso de red habilitado. No se cambia la configuracion de fuentes para sortear este problema.
- El conector Vercel devolvio una lista de equipos vacia; no se obtuvo una nueva medicion ni se verifico el despliegue desde el conector.
- Prueba movil y comparacion de solicitudes antes/despues: pendientes de validacion en linea.
