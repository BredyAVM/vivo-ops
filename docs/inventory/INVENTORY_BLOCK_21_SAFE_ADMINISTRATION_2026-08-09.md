# Bloque 21: administración segura y recetas versionadas

## Objetivo

Permitir que Administración entienda y modifique la configuración de inventario
sin editar saldos, romper la trazabilidad ni reemplazar una receta activa por
accidente.

No se crearon tablas ni columnas. Se reutilizaron `products`,
`inventory_items`, `product_inventory_links`, `inventory_recipes` e
`inventory_recipe_components`.

## Tres capas distintas

### Producto comercial

Es lo que se ofrece en el catálogo. Desde **Reglas y catálogo > Editar
producto** se pueden corregir:

- nombre;
- SKU;
- piezas o unidades por servicio;
- permiso de medio servicio;
- condición temporal;
- límite de selección para productos flexibles.

El formulario muestra órdenes históricas, órdenes abiertas, productos que lo
usan y el descuento físico configurado. No cambia precios, composición,
política, enlaces físicos ni existencias. Los pedidos históricos conservan sus
snapshots de nombre y SKU.

### Ítem físico

Es la unidad realmente contada y movida. Desde **Editar ítem físico** se pueden
corregir:

- nombre;
- modo de disponibilidad;
- umbral de alerta y si el límite es inclusivo;
- stock objetivo;
- vida útil;
- frecuencia y responsable de conteo;
- nota operativa.

Unidad, tipo, grupo y modo de seguimiento aparecen como solo lectura porque
cambiarlos reinterpretaría movimientos ya registrados. El saldo nunca se cambia
desde este editor.

### Receta

Es la transformación de uno o más ítems físicos en otro ítem físico. Desde
**Versionar receta** se elige la salida y se configura:

- tipo de transformación: producción o porcionado;
- cantidad producida;
- tiempo en minutos;
- múltiplo de producción;
- ítems consumidos y cantidades;
- explicación del cambio.

Guardar produce un borrador v2, v3, etc. La receta activa permanece intacta.
Activar el borrador desactiva la versión anterior de forma atómica y la conserva
como historial. Las producciones ya iniciadas continúan asociadas a la versión
con la que comenzaron.

## Ejemplo: presentación prefrita de 10 Bombys

Si será un stock almacenado por separado:

1. Crear un producto comercial nuevo y un ítem físico propio desde
   **Crear producto o ítem nuevo**.
2. Declarar `10` como unidades por servicio.
3. Presentar y aceptar la apertura del nuevo ítem, aunque el saldo inicial sea
   cero, y activarlo.
4. En **Versionar receta**, seleccionar el nuevo ítem como salida.
5. Configurar salida `1 servicio`, tiempo `240 minutos` e insumo
   `10 Bombys Crudos`.
6. Guardar el borrador, revisar la comparación y activarlo.
7. Activar finalmente el producto comercial desde la cola de validación.

Si no se almacenará por separado, no debe crearse una receta ni un stock nuevo:
se configura el producto para consumir directamente diez piezas crudas.

## Navegación

- **Existencias:** cuánto hay físicamente.
- **Entradas:** mercancía esperada y recibida.
- **Producción:** ejecutar recetas activas y cerrar preparaciones.
- **Conteos:** conteos, diferencias y revisiones.
- **Productos:** qué descuenta cada producto comercial.
- **Reportes:** saldos y trazabilidad.
- **Alertas:** eventos y procura.
- **Reglas y catálogo:** editar reglas, versionar recetas y crear borradores.
- **Auditoría:** preparación técnica y diagnóstico del centro.

La apertura inicial dejó de aparecer en el menú cotidiano porque es un proceso
único ya completado. Su ruta no fue eliminada.

## Seguridad y certificación

Las escrituras nuevas son RPC `security definer` intencionales, con
`search_path` vacío, ejecución revocada a `public` y `anon`, autenticación
obligatoria y verificación interna del rol `admin`.

Se ejecutó una prueba transaccional con `ROLLBACK` que validó:

- edición inocua de producto;
- edición inocua de controles del ítem;
- creación de una nueva versión sin alterar la receta activa;
- activación atómica y conservación de la versión anterior;
- 13 recetas canónicas activas antes y después de la sustitución;
- cero borradores residuales después del rollback;
- `inventory_blocks_orders = false`.

La compilación de producción de Next.js terminó sin errores.
