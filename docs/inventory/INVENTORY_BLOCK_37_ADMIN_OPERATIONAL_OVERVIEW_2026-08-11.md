# Bloque 37 — resumen administrativo operativo

Fecha: 2026-08-11

## Resultado

La portada de Inventario General deja de ser una ficha técnica del esquema y se
convierte en una lista de decisión. Al abrirla, Administración ve:

- existencia física;
- unidades comprometidas dentro del horizonte canónico de 10 días;
- cantidad libre sin depender de entradas futuras;
- reposiciones o producciones esperadas;
- mínimo y objetivo;
- último conteo y frecuencia;
- alertas o datos pendientes.

Los seis indicadores superiores también son filtros: atención, bajo o agotado,
sin mínimo, con compromisos, con reposición y todos los activos. La tabla admite
búsqueda y filtro por familia.

## Reutilización y carga

No se creó otro contrato de lectura. La portada consume
`inventory_reporting_workspace_v1(10)`, el mismo modelo canónico que ya calcula
compromisos, entradas y capacidad. La consulta se ejecuta solamente al abrir el
dominio `/app/inventory`; no aumenta la carga inicial de la dashboard.

Cada fila ofrece acceso directo al perfil de ese ítem mediante `itemId`, sin
precargar el configurador desde la portada. Las entradas y los ajustes siguen
en sus rutas existentes.

## Regla de visualización

Solo aparecen ítems activos y rastreados por el contrato canónico. Los ítems que
ya no se compran deben retirarse mediante el ciclo de vida del bloque 36; así no
ensucian conteos ni alertas y no requieren excepciones visuales permanentes.
