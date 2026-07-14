# 📝 Lista de Tareas Pendientes y Distribución de Trabajo (BookCenter)
*Esta lista contiene las funcionalidades que faltan implementar, detallando los archivos afectados para facilitar el trabajo en equipo sin conflictos.*

---

## 🛠️ Archivos a modificar por Categoría

### 1. Seguridad y Auditoría (CU-01 Iniciar Sesión)
- **Base de Datos (MySQL):** Crear tabla `LogAuditoria` (fecha, hora, id_usuario, accion).
- **Backend (`server.js`):** Modificar el endpoint `app.post('/api/login')` para usar `bcrypt.compare` (si se encriptan) y hacer un `INSERT` en `LogAuditoria`.
- **Frontend (`index.html`):** (Opcional) Ajustar manejo de errores si el backend cambia sus respuestas.

### 2. Gestión de Stock (CU-05 y CU-06)
- **Backend (`server.js`):**
  - Modificar `/api/guardar-pedido`: Agregar lógica (`SELECT`) para validar que `cantidad <= stock` antes del `INSERT`.
  - Modificar `/api/procesar-pago`: Agregar el `UPDATE Producto SET stock = stock - cantidad`.
- **Frontend (`registrar-pedido.html` y `procesar-pago.html`):** Capturar y mostrar mensajes de error ("Stock insuficiente") si el backend rechaza la operación.

### 3. Lógica de Comprobantes de Pago (CU-06 Registrar Pago)
- **Base de Datos:** (Ningún cambio necesario si `tipo_comprobante` ya acepta 'Factura').
- **Frontend (`procesar-pago.html`):** Asegurarse de que al enviar el pago al backend, se indique si el cliente usó RUC o DNI.
- **Backend (`server.js`):** Modificar `/api/procesar-pago` para insertar 'Factura' o 'Boleta' dinámicamente según el tipo de documento del cliente, en lugar del 'Boleta' hardcodeado.

### 4. Gestión de Comprobantes y Estados (CU-07 Anular Comprobante)
- **Base de Datos:** Añadir columna `motivo_anulacion` a la tabla de Comprobantes o Pedidos.
- **Frontend (`menu-admin.html`):** Al hacer clic en "Anular", mostrar un modal o `prompt()` pidiendo el motivo, y enviarlo en la petición.
- **Backend (`server.js`):** Modificar `/api/admin/comprobantes/:id/anular` para:
  1. Recibir y guardar el motivo.
  2. Hacer `UPDATE` al Pedido para devolverlo a estado "Pendiente".
  3. Hacer `UPDATE Producto SET stock = stock + cantidad` para devolver el stock.

### 5. Mantenimiento de Pedidos (CU-08 Gestión de Pedidos)
- **Backend (`server.js`):** 
  - Crear ruta `app.put('/api/admin/pedidos/:id')` para modificar.
  - Crear ruta `app.delete('/api/admin/pedidos/:id')` para eliminar.
  - Modificar los `GET` de pedidos y comprobantes para aceptar parámetros de búsqueda `?estado=` o `?fecha=`.
- **Frontend (`menu-admin.html`):** Agregar botones de edición/eliminación en la tabla de pedidos, con sus respectivos modales y lógica de JS (fetch PUT/DELETE).

---

## 👥 Propuesta de Distribución de Trabajo (2 Personas)

Para evitar conflictos de código (especialmente en Git o al pasarse archivos) y que ambos no modifiquen las mismas líneas de `server.js` al mismo tiempo, esta es la mejor distribución basada en **Módulos Independientes**:

### 👨‍💻 Desarrollador A: Módulo de Ventas y Core (Flujo del Cliente)
**Se enfoca en la creación del pedido y el pago.**
* **Tareas a cargo:**
  1. Gestión de Stock en Pedidos (CU-05) y Pagos (CU-06).
  2. Lógica de Comprobantes de Pago (Boleta vs Factura).
* **Archivos que tocará principalmente:**
  - `registrar-pedido.html`
  - `procesar-pago.html`
  - `server.js` *(Solo las rutas `/api/guardar-pedido` y `/api/procesar-pago`)*

### 👨‍💻 Desarrollador B: Módulo Administrativo y Seguridad
**Se enfoca en las funciones del administrador y las reglas del negocio post-venta.**
* **Tareas a cargo:**
  1. Seguridad y Auditoría (CU-01, encriptación y tabla Log).
  2. Gestión de Comprobantes, Anulación y devolución de Stock (CU-07).
  3. Mantenimiento de Pedidos, CRUD y Filtros (CU-08).
* **Archivos que tocará principalmente:**
  - `index.html`
  - `menu-admin.html`
  - Base de Datos (Crear tabla `LogAuditoria` y añadir columna de motivo).
  - `server.js` *(Solo rutas de `/api/login` y todas las rutas `/api/admin/...`)*

💡 **Ventaja de esta distribución:** El Desarrollador A trabaja en la parte superior/media de `server.js` (rutas públicas y de cliente) y sus respectivos HTML, mientras que el Desarrollador B trabaja en las rutas del panel de administración al final de `server.js` y en el `menu-admin.html`. ¡Así minimizan los problemas al juntar el código!
