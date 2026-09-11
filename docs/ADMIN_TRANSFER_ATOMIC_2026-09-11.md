# Traspasos certificados — 11 de septiembre de 2026

Migraciones aplicadas: `20260911144604_money_transfer_command_v1.sql` y
`20260911145036_money_transfer_reversal_v1.sql`.

La salida, entrada y comisión ya se insertaban en lote. Este bloque añade un
comando administrativo único, autorización persistida, bloqueo ordenado de ambas
cuentas y comprobante protegido con identidad de envío estable desde el formulario.
Un reintento con iguales datos devuelve el mismo resultado; datos cambiados no
reutilizan el envío. No se pide ningún campo nuevo al usuario.

Los tres movimientos conservan sus monedas nativas, equivalentes, fecha y tasas.
No se exige igualdad artificial entre los importes de origen y destino ni se
inventa una ganancia/pérdida cambiaria: se mantienen las condiciones existentes.
La comisión es opcional; cero no crea un movimiento ficticio.

Los traspasos nuevos no admiten cambios de importes/vínculos ni borrado. Una
restricción diferida impide anular una sola parte y dejar las demás confirmadas.
Anulación completa con Admin y motivo continúa permitida desde el botón actual,
que ahora llama al comando con la sesión normal y deriva el grupo en el servidor.
La evidencia protegida conserva actor, hora, datos enviados e identificadores.

Pruebas: cuentas sintéticas USD/VES en `tests/admin/money-transfer.rollback.sql`,
siempre revertidas. Fallo de comisión revierte las dos partes anteriores; reenvío
no duplica; cambio de datos, importes no finitos, tasas y cuentas inválidas fallan;
anulación parcial y alteración de importes se rechazan; anulación completa pasa.
Todos los roles no Admin y anónimo son rechazados. Dos pruebas de contrato cubren
el formulario y la acción. Compilación de producción y tipos de aplicación pasan.
El asesor de seguridad señala descubribilidad del esquema GraphQL por SELECT;
el contenido de comprobantes sigue limitado por RLS a Admin/Master.

Límites: identidad vive durante la apertura del formulario; recargar/cerrar e
iniciar otro traspaso es una intención nueva. No se certifican transferencias
históricas por parecido de descripciones. No se modifica el circuito de cierres
POS ni los traslados de otros comandos. No es una prueba de carga concurrente.
