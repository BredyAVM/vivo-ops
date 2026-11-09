# Prueba local de respuesta de publicación

Desde la raíz del repositorio:

```powershell
node node_modules/next/dist/bin/next dev tests/commissions/fixtures/goal-feedback --webpack --port 3219 --hostname 127.0.0.1
```

Abrir `http://127.0.0.1:3219/`. La acción simulada espera 12 segundos para comprobar
el estado de espera, los botones deshabilitados y las respuestas de éxito/error.
Usa los componentes y formulario reales, pero no llama a Supabase, no necesita
credenciales y no publica metas ni envía notificaciones reales. El entorno queda
fuera de la aplicación desplegada y de la comprobación de tipos de producción.
