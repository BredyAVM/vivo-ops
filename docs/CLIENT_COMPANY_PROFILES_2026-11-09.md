# Empresas guardadas por cliente

## Alcance

El formulario movil del asesor y el editor operativo de Master/Administracion
permiten elegir varias empresas del mismo cliente. No hay un limite artificial
de dos empresas. Cada opcion tiene nombre, datos de factura y datos de nota de
entrega independientes; solo una es principal.

La interfaz ofrece un selector compacto y, plegadas, las acciones explicitas:

- Guardar como nueva: crea otra opcion, sin sobrescribir la seleccionada.
- Actualizar seleccionada: modifica solamente esa empresa y su version.
- Usar como principal: propone esa empresa al iniciar proximos pedidos.

Los datos se editan en los campos de factura/nota que ya tiene el formulario.
Esos documentos deben marcarse expresamente si corresponden al pedido. Elegir
empresa no activa factura, IVA ni nota de entrega. Enter en el nombre de la
opcion no envia accidentalmente el formulario del pedido.

## Persistencia y compatibilidad

- Tabla: `public.client_company_profiles`, relacionada por `client_id`.
- Guardado: wrapper `public.save_client_company_profile_v1` y comando acotado
  en `app_private`, con autenticacion, roles y validacion de campos.
- Lectura permitida a Asesor/Master/Admin, conforme al acceso compartido de
  clientes vigente. No se amplian permisos sobre clientes ni sobre ordenes.
- Escritura directa de la tabla denegada; no se usa una clave administrativa
  en el navegador. Anonimos, Cocina, Driver y Counter no gestionan estas fichas.
- Bloqueo por cliente, indice unico para principal/nombre, version esperada
  y UUID reutilizable para reintentos. Una version obsoleta no pisa cambios.
- Guardar un pedido con un cliente existente en estas interfaces no actualiza
  implicitamente su ficha de empresa ni sus campos fiscales planos legacy.
  Actualizar direcciones frecuentes conserva su comportamiento habitual.
- Los documentos de cada pedido siguen como snapshots en `extra_fields.documents`.
  Se toman de los campos enviados del formulario, no de la empresa principal
  legacy. No se reescriben pedidos anteriores al cambiar una ficha guardada.
- Borradores, repeticion y edicion conservan sus datos explicitos. El valor
  principal solo se propone en creacion nueva, y no reemplaza texto escrito
  durante la carga ni mientras se envia el pedido.
- Los clientes nuevos aun no guardados conservan el flujo de creacion actual.
  Una vez registrados se pueden agregar sus opciones de empresa al seleccionarlos.
- El dashboard legacy `MasterDashboardClient.tsx` no se modifico. Sus campos
  planos siguen como compatibilidad; no escribe ni borra empresas de esta tabla.
  El selector de Master/Admin se incorpora en su editor operativo compartido.

## Migracion aplicada

`20261109161531_client_company_profiles.sql`, aplicada a produccion el 2026-11-09.
Los datos actuales de 81 clientes se copiaron a una opcion Principal por cliente.
No se borraron ni cambiaron campos planos, pedidos, pagos o historiales. No se
importaron empresas alternativas desde snapshots historicos contradictorios.

## Verificacion

- 53 pruebas: seis sobre PostgreSQL aislado y 47 de documentos, snapshots,
  guardado atomico, doble envio, borradores ASAP y repeticion/CRM.
- Verificacion TypeScript de la aplicacion completa, sin errores.
- Prueba autenticada en produccion de crear otra empresa, cambiar principal,
  actualizar y rechazar una version obsoleta, siempre dentro de ROLLBACK.
  Resultado final: 81 opciones, 81 principales, cero registros de prueba.
- ESLint del componente, acciones y helpers nuevos sin errores. En archivos
  existentes permanecen dos advertencias de hooks y un `any` previo en el
  editor operativo; no se ampliaron cambios para corregirlos.
- Revision de seguridad de Supabase: RLS habilitado, ninguna exposicion anonima
  del nuevo comando. La tabla es descubrible por usuarios autenticados en el
  esquema GraphQL, igual que otras tablas de la aplicacion; las filas siguen
  sujetas a su politica RLS. No es una auditoria global de todos los avisos.
- Sin servidor local ni validacion visual en iPhone. La prueba movil se realiza
  tras el despliegue conectado a main.

## Prueba movil sugerida

1. Seleccionar un cliente con datos existentes y marcar factura o nota.
2. Comprobar los datos de Principal; editarlos para otra empresa.
3. Abrir Guardar o actualizar empresa, escribir otro nombre y Guardar como nueva.
4. Alternar entre ambas opciones y comprobar que sus datos son independientes.
5. Crear el pedido con la segunda empresa; volver a abrirlo y verificar sus datos.
6. Actualizar la ficha guardada y comprobar que el pedido anterior no cambia.
7. Probar tambien borradores y una entrega sin factura/nota: no deben activarse solos.
