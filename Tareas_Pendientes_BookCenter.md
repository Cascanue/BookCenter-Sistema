# 📝 Lista de Tareas Pendientes (BookCenter)
*Esta lista contiene las funcionalidades que faltan implementar en el sistema web (backend/frontend) para que coincida con la documentación y los diagramas del proyecto.*

## 1. Seguridad y Auditoría (CU-01 Iniciar Sesión)
- [ ] **Encriptación de Contraseñas:** Modificar el backend para evaluar y guardar contraseñas usando un hash seguro (ej. `bcrypt`). Actualmente se comparan en texto plano.
- [ ] **Log de Auditoría:** Crear una tabla `LogAuditoria` en la base de datos (con fecha, hora, id_usuario, acción).
- [ ] Registrar un evento en la tabla `LogAuditoria` cada vez que un usuario inicie sesión exitosamente.

## 2. Gestión de Stock (CU-05 Registrar Pedido y CU-06 Registrar Pago)
- [ ] **Validación de Stock antes de Guardar (CU-05):** Modificar el endpoint `/api/guardar-pedido`. Antes de hacer el `INSERT`, el sistema debe hacer un `SELECT` para verificar que la cantidad solicitada no supere el stock real en la base de datos.
- [ ] **Descuento de Stock Real (CU-06):** Al confirmar y procesar un pago, el sistema debe ejecutar un `UPDATE Producto SET stock = stock - cantidad` por cada artículo vendido.

## 3. Lógica de Comprobantes de Pago (CU-06 Registrar Pago)
- [ ] **Validación Boleta vs Factura:** Modificar el sistema para evaluar si el cliente proporcionó un RUC o solo un DNI.
- [ ] Generar **Boleta** si es DNI, y **Factura** si es RUC (actualmente el sistema siempre guarda como 'Boleta' por defecto).

## 4. Gestión de Comprobantes y Estados (CU-07 Anular Comprobante)
- [ ] **Devolución de Stock:** Al anular un comprobante, el sistema debe devolver los productos al stock mediante un `UPDATE Producto SET stock = stock + cantidad`.
- [ ] **Registro de Motivo de Anulación:** Modificar la base de datos para aceptar un "Motivo" al anular. El sistema debe solicitar este motivo al usuario y guardarlo.
- [ ] **Restaurar Estado del Pedido:** Cuando se anula un comprobante, el pedido asociado debe regresar al estado "Pendiente" (actualmente solo se cambia a "Anulado").

## 5. Mantenimiento de Pedidos (CU-08 Gestión de Pedidos)
- [ ] **Endpoint para Modificar Pedido (PUT):** Crear una ruta en `server.js` que permita editar las cantidades de un pedido existente.
- [ ] **Endpoint para Eliminar Pedido (DELETE):** Crear una ruta en `server.js` que permita eliminar (o inactivar) un pedido por completo.
- [ ] **Filtros en el Backend:** Implementar filtros en el endpoint `GET /api/admin/pedidos` (por estado del pedido) y en `GET /api/admin/comprobantes` (por rango de fechas), que actualmente no existen.
