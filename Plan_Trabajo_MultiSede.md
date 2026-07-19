# Plan de Trabajo: Migración Multi-Sede + Correcciones — Book Center

> Organizado para 2 personas. Basado en el "Informe de Migración: Arquitectura Multi-Sede"
> y en las correcciones pendientes detectadas en el análisis del sistema (2026-07-17).

---

## Nota previa: bug detectado que este plan corrige

`confirmar-pedido.html` (líneas ~579-580) lee `localStorage.usuarioInfo`, **que ninguna página
escribe** (el login guarda `idUsuario` / `rolUsuario` / `nombreUsuario` sueltos). Por eso
**todos los pedidos se registran hoy como creados por el usuario 1**. La migración a JWT
(Fase 1) lo corrige de raíz al unificar la sesión.

## Nota previa: ¿el POS actual cuenta como "pasarela de pago simulada"?

**No como está implementado, pero puede documentarse como tal si se precisa.** Hoy el flujo
de tarjeta es: modal muestra el monto → el cajero digita un voucher opcional → se marca
pagado. No hay tercero que autorice nada; es un **registro manual de un cobro que ocurre
fuera del sistema** (POS físico externo). Una pasarela —real o simulada— implica que el
sistema envía la transacción a un servicio y recibe aprobación/rechazo; eso solo lo tiene
Mercado Pago (billeteras QR), que sí es pasarela real.

Opciones para el informe:

- **(a)** Documentarlo honestamente como "cobro con POS físico externo con registro manual
  de voucher" (no pasarela).
- **(b)** Si el curso exige pasarela para tarjetas, agregar un mini-endpoint
  `/api/simular-pasarela-tarjeta` que "autorice/rechace" y devuelva un código de
  autorización — con eso ya es una simulación legítima y el flujo alterno de CU-06
  ("pasarela rechaza → reintentar") se vuelve implementable. Incluida como tarea opcional
  en la Fase 3.

---

## División de roles

- **Persona A — Backend y Base de Datos:** dueña de `server.js`, scripts SQL y contratos de API.
- **Persona B — Frontend:** dueña de `menu-admin.html`, `index.html`, `js/config.js` y ajustes
  menores en las demás páginas.

**Regla de oro para no pisarse: A nunca toca los HTML, B nunca toca server.js.**
Todo lo que cruce la frontera se acuerda antes como "contrato de API" (nombre del endpoint,
request, response). Trabajar en ramas `feature/…` y hacer merge a `main` al cerrar cada fase.

---

## FASE 0 — Decisiones y contratos (juntos, 1 sesión)

Bloqueante: sin esto nadie escribe código.

1. **Definir las sedes iniciales** (¿2?, códigos "SA"/"SB", nombres, direcciones) y confirmar
   que **todo dato histórico se asigna a la sede 1**.
2. **Formato de serie de comprobantes por sede:** propuesta `B001-SA-00000001` /
   `F001-SA-00000001` (tipo + serie + sede + correlativo). Decidir si el correlativo es
   independiente por sede Y por tipo (lo tributariamente correcto).
3. **Contrato del token JWT:** payload `{ id_usuario, id_rol, id_sede }` (admin →
   `id_sede: null`), expiración (sugerido 8 h = un turno), respuesta del login
   `{ exito, token, usuario: {...} }`.
4. **Contrato de sesión frontend:** se elimina la dispersión actual (`idUsuario`,
   `rolUsuario`, `nombreUsuario`, el fantasma `usuarioInfo`) y queda `token` + `usuarioInfo`
   (JSON). Documentar en config.js.
5. Congelar la lista de endpoints nuevos (detallados en las fases siguientes).

---

## FASE 1 — Fundaciones: BD multi-sede + JWT

### Persona A

**A1. Script SQL de migración** (un solo archivo versionado `migracion_multisede.sql`):

- `CREATE TABLE Sede` (`id_sede` INT AUTO_INCREMENT PK, `codigo_sede` VARCHAR(5) UNIQUE,
  `nombre` VARCHAR(100), `direccion` VARCHAR(255), `is_active` TINYINT DEFAULT 1)
  + INSERT de las sedes definidas en Fase 0.
- `CREATE TABLE Inventario_Sede` (`id_inventario` INT AUTO_INCREMENT PK, `id_producto` FK,
  `id_sede` FK, `stock_actual` INT DEFAULT 0, `stock_minimo` INT DEFAULT 5,
  **UNIQUE(id_producto, id_sede)** — clave para evitar duplicados y hacer UPSERT).
- Migrar datos ANTES de borrar columnas:
  ```sql
  INSERT INTO Inventario_Sede (id_producto, id_sede, stock_actual, stock_minimo)
  SELECT id_producto, 1, stock_actual, stock_minimo FROM Producto;
  ALTER TABLE Producto DROP COLUMN stock_actual, DROP COLUMN stock_minimo;
  ```
- `ALTER TABLE Usuario ADD id_sede INT NULL` (+FK); `Pedido` y `Comprobante_Pago` igual
  (con backfill a sede 1 para filas existentes). Admin global → `id_sede = NULL`.
- Aprovechar y añadir (corrección de Fase 3): `Pago.vuelto DECIMAL(10,2)`,
  `Pago.fecha_pago DATETIME DEFAULT CURRENT_TIMESTAMP` y tabla `Correlativo_Sede`
  (`id_sede`, `tipo_comprobante`, `ultimo_numero`) para numeración segura.
- ⚠️ Eliminar del arranque de server.js los `ALTER TABLE`/`UPDATE` automáticos
  (líneas ~47-62), incluido el `UPDATE` que reescribe el nombre del usuario 1 en cada
  arranque. Las migraciones viven en el script, no en el arranque.

**A2. JWT:**

- `npm i jsonwebtoken`, secreto en `.env` (`JWT_SECRET`).
- `/api/login` firma el token con `{ id_usuario, id_rol, id_sede }` y lo devuelve.
  **Aquí mismo aplicar el mensaje único "Usuario o contraseña incorrectos"** para ambos
  casos (usuario inexistente y contraseña errada).
- Middleware `verificarToken` que puebla `req.usuario`; aplicarlo a todas las rutas
  `/api/*` excepto login y recuperación de contraseña. Respuesta 401 estándar
  `{ exito:false, codigo:'TOKEN_INVALIDO' }` para que el frontend sepa redirigir al login.

### Persona B

**B1. Capa de sesión en config.js:** además de `URL_BACKEND`, agregar helpers globales
`apiFetch(ruta, opciones)` (adjunta `Authorization: Bearer` y, ante 401, limpia sesión y
redirige a `/`) y `getUsuario()`. Todas las páginas ya cargan config.js, así que el helper
queda disponible en todas.

**B2. index.html:** guardar `token` + `usuarioInfo`; esto arregla de paso el bug del
vendedor fantasma (usuario 1) en confirmar-pedido.

**B3. Migrar los `fetch(...)` de las 8 páginas a `apiFetch(...)`** — cambio mecánico pero
transversal; hacerlo en una sola rama para evitar conflictos. En confirmar-pedido.html
(~línea 579) reemplazar la lectura de `usuarioInfo` rota por `getUsuario()` y eliminar el
fallback `|| 1`.

**Criterio de cierre de fase:** login funciona con token, cualquier endpoint sin token
responde 401, y el flujo completo actual (pedido→pago) sigue funcionando igual que hoy
en sede 1.

---

## FASE 2 — Segmentación por sede

### Persona A (el grueso)

- **`GET /api/productos`:** JOIN con `Inventario_Sede` filtrando por la sede del token
  (o `?sede=` si es admin). Devuelve los mismos campos que hoy (`stock_actual`,
  `stock_minimo` vienen del inventario) → **así el catálogo del vendedor no requiere
  cambios de frontend**.
- **`POST /api/guardar-pedido`:** toma `id_sede` del token (no del body — seguridad),
  lo inserta en `Pedido`, y la validación de stock consulta `Inventario_Sede` de esa sede.
- **`POST /api/procesar-pago`:** descuento de stock sobre `Inventario_Sede` de la sede del
  pedido; comprobante con `id_sede` y serie por sede.
- **`PUT /api/admin/comprobantes/:id/anular`:** la devolución de stock va a la sede del pedido.
- **Endpoints admin (`/api/admin/*`, `/api/pedidos/:id`):** aceptar `?sede=N` opcional;
  sin parámetro y rol admin → todas las sedes (agregando el nombre de la sede en cada fila
  para las tablas).
- **CRUD de productos del admin:** al crear un producto, crear filas de inventario para
  todas las sedes activas (stock 0 salvo la sede indicada); editar stock edita
  `Inventario_Sede` de la sede seleccionada.
- **Bloqueo de caja cruzada:** un cajero solo puede cobrar pedidos de su sede
  (validar `pedido.id_sede === token.id_sede`).
- **`GET /api/sedes`** + CRUD de sedes para el panel admin.

### Persona B

- **Selector de Sede global** en el header de menu-admin
  (`<select id="selectorSedeGlobal">` con "Todas las sedes" + sedes activas, cargadas de
  `GET /api/sedes`). Guardarlo en una variable y añadir `?sede=` a las peticiones de todas
  las vistas; columna "Sede" en tablas de pedidos/comprobantes.
- **Gestión de Sedes** (vista simple en el sidebar admin: listar/crear/editar/desactivar).
- Verificar que vendedor/cajero no requieren ningún cambio visual (solo ven su sede —
  sale gratis del backend).

**Criterio de cierre:** dos usuarios de sedes distintas ven catálogos/stocks distintos;
el admin alterna sedes y ve totales globales.

---

## FASE 3 — Integridad transaccional (Persona A, en paralelo con Fase 4 de B)

1. **Stock re-validado al pagar (RN-01/RN-02):** dentro de la transacción de
   procesar-pago, descontar con
   `UPDATE Inventario_Sede SET stock_actual = stock_actual - ? WHERE id_producto=? AND id_sede=? AND stock_actual >= ?`
   y **verificar `affectedRows`**: si es 0 → ROLLBACK con mensaje "Stock insuficiente
   para X; el pedido debe modificarse". Elimina el stock negativo sin necesidad de reservas.
2. **Correlativo seguro:** reemplazar `COUNT(*)+1` (server.js ~805) por la tabla
   `Correlativo_Sede` con `SELECT ... FOR UPDATE` + incremento dentro de la transacción
   (por sede y tipo de comprobante). A prueba de concurrencia y de huecos.
3. **Pago fiel (CU-06):** el backend recibe `monto_recibido` real y guarda
   `monto_recibido`, `vuelto` y `fecha_pago`. *(Coordinar con B: en procesar-pago.html
   ~línea 2093 el payload debe añadir `monto_recibido` — B lo hace en su rama, contrato
   acordado en Fase 0.)*
4. **Eliminar pedido → Anulado:** cambiar el `DELETE` físico (server.js ~628-659) por
   `UPDATE estado='Anulado'` + auditoría (solo Pendientes, igual que hoy). *(B: en
   menu-admin cambiar textos "Eliminar/eliminado" por "Anular/anulado" y que la fila
   anulada quede visible con badge, como ya pasa con comprobantes.)*
5. **Validaciones de producto:** rechazar eliminación si el producto está en algún
   `Detalle_Pedido` de un pedido `Pendiente` (mensaje del informe: "El producto pertenece
   a un pedido en curso"); rechazar nombre duplicado en POST/PUT (case-insensitive,
   entre activos).
6. *(Opcional, según decisión sobre el POS)* **Pasarela simulada de tarjeta:**
   `POST /api/simular-pasarela-tarjeta` que valida formato y devuelve aprobado/rechazado
   con código de autorización; procesar-pago la registra como referencia.

---

## FASE 4 — Nuevas funcionalidades del panel admin (Persona B, con endpoints de A)

1. **Reportes de ventas** (pedidos **Completados**):
   - A expone `GET /api/admin/reportes/ventas?agrupacion=dia|semana|mes&desde=&hasta=&sede=`
     (agregación SQL: `SUM(total)`, `COUNT(*)`, agrupado con `DATE()`, `YEARWEEK()`,
     `DATE_FORMAT('%Y-%m')`).
   - B crea la vista "Reportes" en el sidebar: selector diario/semanal/mensual, rango de
     fechas, filtro de sede, tabla de resultados con totales, y opcionalmente un gráfico
     de barras.
2. **Gestión de usuarios:**
   - A: `GET/POST/PUT /api/admin/usuarios` + `PUT /:id/desactivar` (bcrypt al crear/resetear
     contraseña, asignación de rol y **sede**, nunca DELETE físico, no permitir
     auto-desactivarse, auditoría).
   - B: vista "Usuarios" en el sidebar (tabla con username, nombre, rol, sede, estado;
     modal crear/editar; toggle activo/inactivo).
3. **Sidebar de categorías:**
   - A: `POST/PUT /api/categorias` + baja lógica (denegar desactivar si tiene productos
     activos).
   - B: vista "Categorías" en el sidebar admin (hoy solo existe el GET; el catálogo del
     vendedor ya las consume, así que cualquier alta aparece automáticamente en
     registrar-pedido).

---

## FASE 5 — Cierre (juntos)

- **Prueba integral cruzada:** cada uno prueba el flujo completo del otro (vendedor sede A
  + cajero sede A + admin global; intentar cobrar desde sede B un pedido de sede A;
  dos pagos simultáneos del mismo stock).
- La verificación puede automatizarse con Playwright (ya usado en este proyecto para
  validar cambios de frontend).
- **Actualizar el informe:** diagrama de BD (Sede, Inventario_Sede, Correlativo_Sede,
  columnas nuevas), diagrama de despliegue (Render/Aiven/Mercado Pago), CU nuevos
  (Gestionar Usuarios, Reportes, Gestionar Sedes/Categorías) y decisión documentada
  sobre el POS.

---

## Resumen de asignación

| Fase | Persona A (Backend/BD) | Persona B (Frontend) | Dependencia |
|------|------------------------|----------------------|-------------|
| 0 | Contratos y decisiones | Contratos y decisiones | — |
| 1 | SQL migración + JWT + mensaje único login | apiFetch/sesión + token en login + fix usuarioInfo | B necesita el contrato del token (no el código) |
| 2 | Segmentar endpoints por sede | Selector de sede + vista Sedes | B necesita `GET /api/sedes` y `?sede=` |
| 3 | Stock atómico, correlativo, pago fiel, anular pedido, validaciones producto | Payload monto_recibido + textos "Anular" | Paralelo a Fase 4 |
| 4 | Endpoints reportes/usuarios/categorías | Vistas reportes/usuarios/categorías | Contratos por endpoint |
| 5 | Pruebas cruzadas + informe | Pruebas cruzadas + informe | — |

**Decisiones pendientes antes de empezar (Fase 0):** sedes iniciales y sus códigos,
formato exacto de la serie de comprobantes, expiración del token, y opción (a) o (b)
para el POS.
