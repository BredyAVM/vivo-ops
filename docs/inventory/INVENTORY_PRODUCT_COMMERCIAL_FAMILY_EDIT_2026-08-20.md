# Certificación — familia comercial editable

Fecha: 2026-08-20

## Alcance

Se habilitó la corrección de la familia comercial de productos existentes desde
el Centro de Inventario, reutilizando `products.type`. No se añadieron tablas ni
columnas.

## Regla canónica

- La familia comercial organiza catálogo, ventas y reportes.
- La configuración física determina qué ítems consume el producto.
- Cambiar una familia comercial no altera recetas, componentes, vínculos de
  inventario, existencias ni órdenes históricas.
- Solo Administración puede guardar este cambio.
- La dashboard remite al editor canónico del Centro de Inventario.

## Corrección certificada

`Degustación Prefritos (8 und)` (`DEGUSTPF_8`) quedó como Obsequio (`gambit`).
Su política continúa siendo `direct` y conserva cinco vínculos que totalizan
ocho unidades crudas por presentación:

- 2 UND de Bombys Crudos;
- 2 UND de Cachitas Crudas;
- 2 UND de Mini tequeño crudo;
- 1 UND de Empanadas Crudas;
- 1 UND de Mandocas Crudas.

## Verificación

- Migración aplicada correctamente en Supabase.
- Prueba transaccional de cambio Combo → Obsequio aprobada y revertida.
- Comparación de la topología física antes y después sin diferencias.
- Función protegida con autenticación, rol administrador, `search_path` vacío,
  bloqueo transaccional por producto y permisos explícitos.
- Compilación de producción aprobada.

Migración: `20260820163156_inventory_product_commercial_family_edit_v1.sql`.
