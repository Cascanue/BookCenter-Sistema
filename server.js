require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// A. CONFIGURACIONES (Cloudinary y Multer)
// ==========================================
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ==========================================
// B. CONEXIÓN A LA BASE DE DATOS (Aiven MySQL)
// ==========================================
const db = mysql.createPool({
    host: process.env.AIVEN_HOST,
    user: process.env.AIVEN_USER,
    password: process.env.AIVEN_PASSWORD,
    port: process.env.AIVEN_PORT || 22639,
    database: process.env.AIVEN_DATABASE || 'defaultdb',
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Error en MySQL:', err);
    } else {
        console.log('✅ Conectado a Aiven MySQL con Pool de conexiones.');

        // MODO AUTOMÁTICO: Crea la columna y pone tu nombre apenas enciende
        const sqlCrear = "ALTER TABLE Usuario ADD COLUMN IF NOT EXISTS nombre_completo VARCHAR(150) NOT NULL DEFAULT 'Usuario del Sistema' AFTER username;";
        const sqlActualizar = "UPDATE Usuario SET nombre_completo = 'Diego Sebastián' WHERE id_usuario = 1;";

        // Anulación de comprobantes (CU-07): motivo y estado propio del comprobante
        const sqlColMotivo = "ALTER TABLE Comprobante_Pago ADD COLUMN IF NOT EXISTS motivo_anulacion VARCHAR(255) NULL;";
        const sqlColEstadoComprobante = "ALTER TABLE Comprobante_Pago ADD COLUMN IF NOT EXISTS estado_comprobante ENUM('Vigente','Anulado') NOT NULL DEFAULT 'Vigente';";

        connection.query(sqlCrear, () => {
            connection.query(sqlActualizar, () => {
                connection.query(sqlColMotivo, (err) => { if (err) console.error('❌ Error creando columna motivo_anulacion:', err); });
                connection.query(sqlColEstadoComprobante, (err) => { if (err) console.error('❌ Error creando columna estado_comprobante:', err); });
                console.log('🌟 ¡LISTO! Base de datos actualizada con tu nombre. Ya puedes iniciar sesión.');
                connection.release();
            });
        });
    }
});

// ==========================================
// CONFIGURACIÓN DE NODEMAILER (Gmail)
// ==========================================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    connectionTimeout: 10000, // 10s
    greetingTimeout: 10000,
    socketTimeout: 10000
});

// Almacén temporal de códigos (en memoria — válidos por 15 minutos)
const codigosRecuperacion = new Map(); // { correo: { codigo, expira, id_usuario } }

// ==========================================
// C. RUTAS DEL SISTEMA (Endpoints)
// ==========================================

// Auditoría (CU-01): registra una acción en Auditoria_Log (hora de Perú UTC-5)
// accion: código corto (máx 50 char, ej. 'LOGIN_EXITOSO'); detalle: texto libre con el contexto
function registrarAuditoria(idUsuario, accion, tablaAfectada, detalle) {
    const fechaHoraPeru = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    db.query(
        'INSERT INTO Auditoria_Log (id_usuario, accion, tabla_afectada, detalle, fecha_hora) VALUES (?, ?, ?, ?, ?)',
        [idUsuario, accion, tablaAfectada, detalle || null, fechaHoraPeru],
        (err) => { if (err) console.error('❌ Error registrando auditoría:', err); }
    );
}

// 1. RUTA DE LOGIN (Verifica credenciales y rol, con hash bcrypt y auditoría)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    const query = `
        SELECT u.id_usuario, u.username, u.nombre_completo, u.password_hash, r.nombre_rol
        FROM Usuario u
        INNER JOIN Rol r ON u.id_rol = r.id_rol
        WHERE u.username = ? AND u.is_active = TRUE
    `;

    db.query(query, [username], (err, results) => {
        if (err) {
            console.error("❌ ERROR SQL:", err);
            return res.status(500).json({ exito: false, mensaje: "Error interno del servidor" });
        }

        if (results.length === 0) {
            registrarAuditoria(null, 'LOGIN_FALLIDO', 'Usuario', `Usuario inexistente: ${username}`);
            return res.status(401).json({ exito: false, mensaje: "Usuario no encontrado" });
        }

        const usuario = results[0];
        const hashGuardado = usuario.password_hash;
        const yaEncriptada = typeof hashGuardado === 'string' && hashGuardado.startsWith('$2');

        const continuarConResultado = (coincide) => {
            if (!coincide) {
                registrarAuditoria(usuario.id_usuario, 'LOGIN_FALLIDO', 'Usuario', `Contraseña incorrecta para: ${usuario.username}`);
                return res.status(401).json({ exito: false, mensaje: "Contraseña incorrecta" });
            }

            registrarAuditoria(usuario.id_usuario, 'LOGIN_EXITOSO', 'Usuario', `Inicio de sesión: ${usuario.username}`);
            res.json({
                exito: true,
                usuario: {
                    id_usuario: usuario.id_usuario,
                    username: usuario.username,
                    nombre_completo: usuario.nombre_completo,
                    nombre_rol: usuario.nombre_rol
                }
            });
        };

        if (yaEncriptada) {
            bcrypt.compare(password, hashGuardado, (errBcrypt, coincide) => {
                if (errBcrypt) {
                    console.error('❌ Error verificando contraseña:', errBcrypt);
                    return res.status(500).json({ exito: false, mensaje: 'Error interno del servidor' });
                }
                continuarConResultado(coincide);
            });
        } else {
            // Migración perezosa: la contraseña aún está en texto plano en la BD.
            // Si coincide, la reemplazamos por su hash bcrypt para futuras validaciones.
            const coincide = password === hashGuardado;
            if (coincide) {
                bcrypt.hash(password, 10, (errHash, nuevoHash) => {
                    if (errHash) return console.error('❌ Error generando hash de contraseña:', errHash);
                    db.query('UPDATE Usuario SET password_hash = ? WHERE id_usuario = ?', [nuevoHash, usuario.id_usuario], (errUpdate) => {
                        if (errUpdate) console.error('❌ Error migrando contraseña a bcrypt:', errUpdate);
                    });
                });
            }
            continuarConResultado(coincide);
        }
    });
});

// 2. RUTA REGISTRAR CLIENTE
app.post('/api/registrar-cliente', (req, res) => {
    const { tipoDoc, numDoc, nombres, apellidoPaterno, apellidoMaterno, telefono, correo, idCreador } = req.body;

    const query = `
        INSERT INTO Cliente (tipo_documento, numero_documento, nombres, apellido_paterno, apellido_materno, telefono, correo, created_by) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(query, [tipoDoc, numDoc, nombres, apellidoPaterno, apellidoMaterno, telefono, correo, idCreador], (err, results) => {
        if (err) {
            console.error('Error guardando cliente:', err);
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ exito: false, mensaje: 'Este documento ya está registrado en el sistema.' });
            }
            return res.status(500).json({ exito: false, mensaje: 'Error interno al guardar en la base de datos' });
        }
        registrarAuditoria(idCreador || null, 'AÑADIR', 'Cliente', `Cliente creado: ${nombres} ${apellidoPaterno} - Doc: ${numDoc}`);
        res.status(200).json({ exito: true, mensaje: 'Cliente registrado exitosamente' });
    });
});

// ==========================================
// D. RUTAS DE INVENTARIO Y VENTAS
// ==========================================

// 3. OBTENER CATEGORÍAS
app.get('/api/categorias', (req, res) => {
    const query = 'SELECT id_categoria, nombre, icono FROM Categoria WHERE is_active = 1';

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al obtener categorías:', err);
            return res.status(500).json({ error: 'Error al obtener categorías' });
        }
        res.json(results);
    });
});

// 4. OBTENER PRODUCTOS
app.get('/api/productos', (req, res) => {
    const query = `
        SELECT id_producto, codigo, nombre, descripcion, id_categoria, url_imagen, precio_venta, stock_actual 
        FROM Producto 
        WHERE is_active = 1
    `;

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al obtener productos:', err);
            return res.status(500).json({ error: 'Error al obtener productos' });
        }
        res.json(results);
    });
});

// 5. OBTENER CLIENTES (Para el buscador del modal)
app.get('/api/clientes', (req, res) => {
    const query = `
        SELECT 
            id_cliente, 
            nombres,
            apellido_paterno,
            apellido_materno,
            CONCAT_WS(' ', nombres, apellido_paterno, apellido_materno) AS nombre, 
            tipo_documento, 
            numero_documento AS num_documento, 
            telefono, 
            correo 
        FROM Cliente
        WHERE is_active = 1
    `;

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al obtener clientes:', err);
            return res.status(500).json({ error: 'Error al obtener clientes' });
        }
        res.json(results);
    });
});

// 6. RUTA GUARDAR PEDIDO (Con Transacción MySQL)
app.post('/api/guardar-pedido', (req, res) => {
    const { id_cliente, id_usuario, total, detalles } = req.body;

    // Pedimos una conexión exclusiva del pool para manejar la transacción
    db.getConnection((err, connection) => {
        if (err) {
            console.error('Error obteniendo conexión:', err);
            return res.status(500).json({ exito: false, mensaje: 'Error de conexión a la BD' });
        }

        // Iniciamos la transacción (Si algo falla, hacemos ROLLBACK)
        connection.beginTransaction(err => {
            if (err) {
                connection.release();
                return res.status(500).json({ exito: false, mensaje: 'Error al iniciar transacción' });
            }

            // PASO 0: Validar Stock Real
            const productoIds = detalles.map(d => d.id_producto);
            if (productoIds.length === 0) {
                return connection.rollback(() => {
                    connection.release();
                    res.status(400).json({ exito: false, mensaje: 'El pedido no tiene productos' });
                });
            }

            const queryStock = `SELECT id_producto, stock_actual, nombre FROM Producto WHERE id_producto IN (?)`;
            connection.query(queryStock, [productoIds], (err, resultsStock) => {
                if (err) {
                    return connection.rollback(() => {
                        connection.release();
                        res.status(500).json({ exito: false, mensaje: 'Error al verificar stock' });
                    });
                }

                // Mapear stock actual
                const stockMap = {};
                const nombresMap = {};
                resultsStock.forEach(r => {
                    stockMap[r.id_producto] = r.stock_actual;
                    nombresMap[r.id_producto] = r.nombre;
                });

                // Verificar si hay suficiente stock
                let errorStock = null;
                for (let item of detalles) {
                    if ((stockMap[item.id_producto] || 0) < item.cantidad) {
                        errorStock = `El producto "${nombresMap[item.id_producto]}" no tiene stock suficiente (Stock disponible: ${stockMap[item.id_producto] || 0}).`;
                        break;
                    }
                }

                if (errorStock) {
                    return connection.rollback(() => {
                        connection.release();
                        res.status(400).json({ exito: false, mensaje: errorStock });
                    });
                }

                // PASO A: Insertar la cabecera en la tabla Pedido (Con hora exacta de Perú UTC-5)
                const fechaPeru = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
                const queryPedido = `INSERT INTO Pedido (id_cliente, id_usuario, total, estado, fecha_pedido) VALUES (?, ?, ?, 'Pendiente', ?)`;

                connection.query(queryPedido, [id_cliente, id_usuario, total, fechaPeru], (err, resultPedido) => {
                if (err) {
                    return connection.rollback(() => {
                        console.error('Error en Cabecera Pedido:', err);
                        connection.release();
                        res.status(500).json({ exito: false, mensaje: 'Error guardando cabecera del pedido' });
                    });
                }

                // Capturamos el ID del pedido recién creado
                const id_pedido = resultPedido.insertId;

                // PASO B: Preparar y guardar los Detalles del Pedido
                // MySQL permite insertar múltiples filas a la vez pasando un array de arrays
                const detallesValues = detalles.map(item => [
                    id_pedido,
                    item.id_producto,
                    item.cantidad,
                    item.precio_venta,
                    (item.cantidad * item.precio_venta) // subtotal
                ]);

                const queryDetalles = `INSERT INTO Detalle_Pedido (id_pedido, id_producto, cantidad, precio_unitario, subtotal) VALUES ?`;

                connection.query(queryDetalles, [detallesValues], (err, resultDetalles) => {
                    if (err) {
                        return connection.rollback(() => {
                            console.error('Error en Detalle Pedido:', err);
                            connection.release();
                            res.status(500).json({ exito: false, mensaje: 'Error guardando detalles del pedido' });
                        });
                    }

                    // PASO C: Si todo fue un éxito, confirmamos la transacción (COMMIT)
                    connection.commit(err => {
                        if (err) {
                            return connection.rollback(() => {
                                connection.release();
                                res.status(500).json({ exito: false, mensaje: 'Error al confirmar la transacción' });
                            });
                        }

                        // Liberamos la conexión y respondemos al frontend
                        connection.release();
                        registrarAuditoria(id_usuario || null, 'AÑADIR', 'Pedido', `Pedido #${id_pedido} creado - Total: S/${total}`);
                        res.status(200).json({
                            exito: true,
                            id_pedido: id_pedido,
                            mensaje: 'Pedido y detalles registrados correctamente'
                        });
                    });
                });
            });
        });
    });
});
});

// ==========================================
// E. RUTAS DE ADMINISTRADOR (Dashboard)
// ==========================================

// 7. OBTENER RESUMEN (KPIs)
app.get('/api/admin/resumen', async (req, res) => {
    try {
        const p = db.promise();
        const [[{ totalProductos }]] = await p.query('SELECT COUNT(*) as totalProductos FROM Producto WHERE is_active = 1');
        const [[{ totalClientes }]] = await p.query('SELECT COUNT(*) as totalClientes FROM Cliente WHERE is_active = 1');
        const [[{ totalPedidos }]] = await p.query('SELECT COUNT(*) as totalPedidos FROM Pedido');
        const [[{ stockCritico }]] = await p.query('SELECT COUNT(*) as stockCritico FROM Producto WHERE is_active = 1 AND stock_actual <= stock_minimo');
        
        res.json({ totalProductos, totalClientes, totalPedidos, stockCritico });
    } catch (err) {
        console.error('Error KPIs:', err);
        res.status(500).json({ error: 'Error obteniendo KPIs' });
    }
});

// 8. CRUD PRODUCTOS
app.post('/api/productos', async (req, res) => {
    try {
        const { nombre, descripcion, precio_venta, stock_actual, stock_minimo, id_categoria, url_imagen, id_usuario } = req.body;
        const p = db.promise();

        // 1. Obtener la categoría para generar el prefijo
        const [[categoria]] = await p.query('SELECT nombre FROM Categoria WHERE id_categoria = ?', [id_categoria]);
        if (!categoria) return res.status(400).json({ error: 'Categoría no válida' });

        // El prefijo son las 3 primeras letras en mayúscula (ej. "LIT" para Literatura)
        const prefijo = categoria.nombre.substring(0, 3).toUpperCase();

        // 2. Buscar el número más alto para ese prefijo
        const [[result]] = await p.query(
            `SELECT MAX(CAST(SUBSTRING_INDEX(codigo, '-', -1) AS UNSIGNED)) as maxNum
             FROM Producto WHERE codigo LIKE ?`,
            [`${prefijo}-%`]
        );

        // 3. Generar el nuevo código (ej. LIT-001)
        const nextNum = (result.maxNum || 0) + 1;
        const nuevoCodigo = `${prefijo}-${String(nextNum).padStart(3, '0')}`;

        // 4. Guardar en la base de datos
        const query = 'INSERT INTO Producto (codigo, nombre, descripcion, precio_venta, stock_actual, stock_minimo, id_categoria, url_imagen, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)';
        await p.query(query, [nuevoCodigo, nombre, descripcion, precio_venta, stock_actual, stock_minimo, id_categoria, url_imagen || null]);

        registrarAuditoria(id_usuario || null, 'AÑADIR', 'Producto', `Producto creado: ${nuevoCodigo} - ${nombre}`);
        res.json({ exito: true, codigo_generado: nuevoCodigo });
    } catch (err) {
        console.error('Error generando producto:', err);
        res.status(500).json({ error: 'Error al crear producto' });
    }
});
app.put('/api/productos/:id', (req, res) => {
    const { nombre, descripcion, precio_venta, stock_actual, stock_minimo, id_categoria, url_imagen, id_usuario } = req.body;
    const query = 'UPDATE Producto SET nombre=?, descripcion=?, precio_venta=?, stock_actual=?, stock_minimo=?, id_categoria=?, url_imagen=? WHERE id_producto=?';
    db.query(query, [nombre, descripcion, precio_venta, stock_actual, stock_minimo, id_categoria, url_imagen || null, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        registrarAuditoria(id_usuario || null, 'MODIFICAR', 'Producto', `Producto actualizado: id ${req.params.id} - ${nombre}`);
        res.json({ exito: true });
    });
});

// 8b. SUBIDA DE IMAGEN DE PRODUCTO A CLOUDINARY
app.post('/api/upload-imagen', upload.single('imagen'), (req, res) => {
    if (!req.file) return res.status(400).json({ exito: false, mensaje: 'No se recibió ninguna imagen' });

    const tiposPermitidos = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!tiposPermitidos.includes(req.file.mimetype)) {
        return res.status(400).json({ exito: false, mensaje: 'Formato de imagen no permitido. Usa PNG, JPG o WEBP.' });
    }

    const stream = cloudinary.uploader.upload_stream(
        { folder: 'bookcenter/productos' },
        (err, result) => {
            if (err) {
                console.error('Error subiendo imagen a Cloudinary:', err);
                return res.status(500).json({ exito: false, mensaje: 'Error al subir la imagen' });
            }
            res.json({ exito: true, url: result.secure_url });
        }
    );
    stream.end(req.file.buffer);
});
app.delete('/api/productos/:id', (req, res) => {
    db.query('UPDATE Producto SET is_active = 0 WHERE id_producto = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        registrarAuditoria(req.query.id_usuario || null, 'ELIMINAR', 'Producto', `Producto eliminado (baja lógica): id ${req.params.id}`);
        res.json({ exito: true });
    });
});

// 9. CLIENTES (Actualizar y Eliminar Lógico)
app.put('/api/clientes/:id', (req, res) => {
    const { tipo_documento, numero_documento, nombres, apellido_paterno, apellido_materno, telefono, correo, id_usuario } = req.body;
    const query = 'UPDATE Cliente SET tipo_documento=?, numero_documento=?, nombres=?, apellido_paterno=?, apellido_materno=?, telefono=?, correo=? WHERE id_cliente=?';
    db.query(query, [tipo_documento, numero_documento, nombres, apellido_paterno, apellido_materno, telefono, correo, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        registrarAuditoria(id_usuario || null, 'MODIFICAR', 'Cliente', `Cliente actualizado: id ${req.params.id} - ${nombres} ${apellido_paterno}`);
        res.json({ exito: true });
    });
});
app.delete('/api/clientes/:id', (req, res) => {
    db.query('UPDATE Cliente SET is_active = 0 WHERE id_cliente = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        registrarAuditoria(req.query.id_usuario || null, 'ELIMINAR', 'Cliente', `Cliente eliminado (baja lógica): id ${req.params.id}`);
        res.json({ exito: true });
    });
});

// 10. PEDIDOS E HISTORIAL
app.get('/api/admin/pedidos', (req, res) => {
    const { estado, fecha } = req.query;
    let query = `
        SELECT p.id_pedido, c.nombres, c.apellido_paterno, p.fecha_pedido, p.total, p.estado
        FROM Pedido p
        LEFT JOIN Cliente c ON p.id_cliente = c.id_cliente
        WHERE 1=1
    `;
    const params = [];
    if (estado) { query += ' AND p.estado = ?'; params.push(estado); }
    if (fecha) { query += ' AND DATE(p.fecha_pedido) = ?'; params.push(fecha); }
    query += ' ORDER BY p.id_pedido DESC';

    db.query(query, params, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});
app.get('/api/admin/pedidos/:id/detalles', (req, res) => {
    const query = `
        SELECT dp.cantidad, dp.precio_unitario, dp.subtotal, pr.nombre
        FROM Detalle_Pedido dp
        JOIN Producto pr ON dp.id_producto = pr.id_producto
        WHERE dp.id_pedido = ?
    `;
    db.query(query, [req.params.id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// Mantenimiento de Pedidos (CU-08): editar estado del pedido
app.put('/api/admin/pedidos/:id', (req, res) => {
    const { estado, id_usuario } = req.body;
    const estadosValidos = ['Pendiente', 'Completado', 'Anulado'];
    if (!estadosValidos.includes(estado)) {
        return res.status(400).json({ exito: false, mensaje: 'Estado no válido' });
    }

    db.query('UPDATE Pedido SET estado = ? WHERE id_pedido = ?', [estado, req.params.id], (err, result) => {
        if (err) return res.status(500).json({ exito: false, mensaje: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ exito: false, mensaje: 'Pedido no encontrado' });
        registrarAuditoria(id_usuario || null, 'MODIFICAR', 'Pedido', `Pedido #${req.params.id} actualizado a estado: ${estado}`);
        res.json({ exito: true });
    });
});

// Mantenimiento de Pedidos (CU-08): eliminar pedido (solo si sigue Pendiente, sin comprobante emitido)
app.delete('/api/admin/pedidos/:id', (req, res) => {
    db.getConnection((err, connection) => {
        if (err) return res.status(500).json({ exito: false, mensaje: 'Error de conexión a la BD' });

        connection.beginTransaction(err => {
            if (err) { connection.release(); return res.status(500).json({ exito: false, mensaje: 'Error al iniciar transacción' }); }

            connection.query('SELECT estado FROM Pedido WHERE id_pedido = ?', [req.params.id], (err, rows) => {
                if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err.message }); });
                if (rows.length === 0) return connection.rollback(() => { connection.release(); res.status(404).json({ exito: false, mensaje: 'Pedido no encontrado' }); });
                if (rows[0].estado !== 'Pendiente') {
                    return connection.rollback(() => { connection.release(); res.status(400).json({ exito: false, mensaje: 'Solo se pueden eliminar pedidos en estado Pendiente' }); });
                }

                connection.query('DELETE FROM Detalle_Pedido WHERE id_pedido = ?', [req.params.id], (err) => {
                    if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err.message }); });

                    connection.query('DELETE FROM Pedido WHERE id_pedido = ?', [req.params.id], (err) => {
                        if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err.message }); });

                        connection.commit(err => {
                            if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: 'Error al confirmar la transacción' }); });
                            connection.release();
                            registrarAuditoria(req.query.id_usuario || null, 'ELIMINAR', 'Pedido', `Pedido #${req.params.id} eliminado`);
                            res.json({ exito: true });
                        });
                    });
                });
            });
        });
    });
});

// 11. COMPROBANTES Y ANULACIONES
app.get('/api/admin/comprobantes', (req, res) => {
    const { estado, fecha } = req.query;
    // La tabla Comprobante_Pago no tiene estado propio; el estado se deduce del pedido asociado
    let query = `
        SELECT cp.id_comprobante, cp.numero_correlativo, cp.tipo_comprobante, cp.fecha_emision, cp.monto_total,
               p.id_pedido, p.estado AS estado_pedido,
               CASE WHEN p.estado = 'Anulado' THEN 'Anulado' ELSE 'Vigente' END AS estado
        FROM Comprobante_Pago cp
        JOIN Pedido p ON cp.id_pedido = p.id_pedido
        WHERE 1=1
    `;
    const params = [];
    if (estado) { query += ` AND CASE WHEN p.estado = 'Anulado' THEN 'Anulado' ELSE 'Vigente' END = ?`; params.push(estado); }
    if (fecha) { query += ' AND DATE(cp.fecha_emision) = ?'; params.push(fecha); }
    query += ' ORDER BY cp.id_comprobante DESC';

    db.query(query, params, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// Anular comprobante (CU-07): guarda el motivo, regresa el pedido a "Pendiente" y devuelve el stock
app.put('/api/admin/comprobantes/:id/anular', (req, res) => {
    const { motivo, id_usuario } = req.body;
    if (!motivo || !motivo.trim()) {
        return res.status(400).json({ exito: false, mensaje: 'Debes indicar el motivo de la anulación' });
    }

    db.getConnection((err, connection) => {
        if (err) return res.status(500).json({ exito: false, mensaje: 'Error de conexión a la BD' });

        connection.beginTransaction(err => {
            if (err) { connection.release(); return res.status(500).json({ exito: false, mensaje: 'Error al iniciar transacción' }); }

            connection.query(
                'SELECT id_pedido, estado_comprobante FROM Comprobante_Pago WHERE id_comprobante = ?',
                [req.params.id],
                (err, rows) => {
                    if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err.message }); });
                    if (rows.length === 0) return connection.rollback(() => { connection.release(); res.status(404).json({ exito: false, mensaje: 'Comprobante no encontrado' }); });
                    if (rows[0].estado_comprobante === 'Anulado') {
                        return connection.rollback(() => { connection.release(); res.status(400).json({ exito: false, mensaje: 'El comprobante ya se encuentra anulado' }); });
                    }

                    const idPedido = rows[0].id_pedido;

                    connection.query(
                        'UPDATE Comprobante_Pago SET estado_comprobante = "Anulado", motivo_anulacion = ? WHERE id_comprobante = ?',
                        [motivo.trim(), req.params.id],
                        (err) => {
                            if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err.message }); });

                            connection.query('UPDATE Pedido SET estado = "Pendiente" WHERE id_pedido = ?', [idPedido], (err) => {
                                if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err.message }); });

                                connection.query('SELECT id_producto, cantidad FROM Detalle_Pedido WHERE id_pedido = ?', [idPedido], (err, detalles) => {
                                    if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err.message }); });

                                    const confirmar = () => {
                                        connection.commit(err => {
                                            if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: 'Error al confirmar la transacción' }); });
                                            connection.release();
                                            registrarAuditoria(id_usuario || null, 'MODIFICAR', 'Comprobante_Pago', `Comprobante #${req.params.id} anulado - Motivo: ${motivo.trim()}`);
                                            res.json({ exito: true });
                                        });
                                    };

                                    if (detalles.length === 0) return confirmar();

                                    let pendientes = detalles.length;
                                    let huboError = false;
                                    detalles.forEach(item => {
                                        connection.query('UPDATE Producto SET stock_actual = stock_actual + ? WHERE id_producto = ?', [item.cantidad, item.id_producto], (err) => {
                                            if (huboError) return;
                                            if (err) {
                                                huboError = true;
                                                return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: 'Error al devolver el stock' }); });
                                            }
                                            pendientes--;
                                            if (pendientes === 0) confirmar();
                                        });
                                    });
                                });
                            });
                        }
                    );
                }
            );
        });
    });
});

// 12. OBTENER PEDIDO POR ID (Para módulo de pago)
app.get('/api/pedidos/:id', (req, res) => {
    const queryPedido = `
        SELECT p.*, c.nombres, c.apellido_paterno, c.tipo_documento, c.numero_documento 
            FROM Pedido p 
            INNER JOIN Cliente c ON p.id_cliente = c.id_cliente 
            WHERE p.id_pedido = ?
    `;
    const queryDetalles = `
        SELECT dp.cantidad, dp.precio_unitario, dp.subtotal, pr.nombre, pr.url_imagen, pr.codigo
        FROM Detalle_Pedido dp
        JOIN Producto pr ON dp.id_producto = pr.id_producto
        WHERE dp.id_pedido = ?
    `;

    db.query(queryPedido, [req.params.id], (err, pedidos) => {
        if (err) return res.status(500).json({ error: err.message });
        if (pedidos.length === 0) return res.status(404).json({ error: 'Pedido no encontrado' });

        db.query(queryDetalles, [req.params.id], (err, detalles) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ...pedidos[0], detalles });
        });
    });
});

// 13. PROCESAR PAGO (Genera comprobante y actualiza estado)
app.post('/api/procesar-pago', (req, res) => {
    const { id_pedido, metodo_pago, cuotas, referencia, tipo_documento } = req.body;

    db.getConnection((err, connection) => {
        if (err) return res.status(500).json({ exito: false, mensaje: 'Error de conexión' });

        connection.beginTransaction(err => {
            if (err) { connection.release(); return res.status(500).json({ exito: false, mensaje: 'Error al iniciar transacción' }); }

            // Verificar que el pedido exista y esté pendiente
            connection.query('SELECT total, estado FROM Pedido WHERE id_pedido = ?', [id_pedido], (err, rows) => {
                if (err || rows.length === 0) {
                    return connection.rollback(() => { connection.release(); res.status(404).json({ exito: false, mensaje: 'Pedido no encontrado' }); });
                }
                if (rows[0].estado !== 'Pendiente') {
                    return connection.rollback(() => { connection.release(); res.status(400).json({ exito: false, mensaje: `El pedido ya tiene estado: ${rows[0].estado}` }); });
                }

                const total = rows[0].total;
                // IGV peruano 18% incluido en el precio (precio ya incluye IGV)
                const igv = parseFloat((total - (total / 1.18)).toFixed(2));

                // Generar número correlativo
                connection.query('SELECT COUNT(*) + 1 AS siguiente FROM Comprobante_Pago', (err, conteo) => {
                    if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err ? err.message : 'Error desconocido' }); });

                    const correlativo = String(conteo[0].siguiente).padStart(8, '0');

                    // Insertar comprobante (con igv calculado y tipo dinámico)
                    const tipoComprobante = (tipo_documento === 'RUC') ? 'Factura' : 'Boleta';
                    const qComp = `INSERT INTO Comprobante_Pago (id_pedido, id_cajero, numero_correlativo, tipo_comprobante, monto_total, igv) VALUES (?, ?, ?, ?, ?, ?)`;
                    const idCajero = parseInt(req.body.id_cajero) || 1;
                    connection.query(qComp, [id_pedido, idCajero, correlativo, tipoComprobante, total, igv], (err, result) => {
                        if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err.message }); });

                        // Insertar registro de pago
                        const qPago = `INSERT INTO Pago (id_comprobante, metodo_pago, monto_recibido) VALUES (?, ?, ?)`;
                        const metodoDB = metodo_pago === 'billetera' ? 'Billetera Digital' : (metodo_pago === 'tarjeta' ? 'Tarjeta' : 'Efectivo');
                        connection.query(qPago, [result.insertId, metodoDB, total], (err) => {
                            if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err.message }); });

                            // Actualizar estado del pedido → "Completado"
                            connection.query("UPDATE Pedido SET estado = 'Completado' WHERE id_pedido = ?", [id_pedido], err => {
                                if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err ? err.message : 'Error desconocido' }); });

                                // DESCONTAR STOCK REAL
                                connection.query('SELECT id_producto, cantidad FROM Detalle_Pedido WHERE id_pedido = ?', [id_pedido], (err, detalles) => {
                                    if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: 'Error al consultar detalles para stock' }); });

                                    if (detalles.length === 0) {
                                        connection.commit(err => {
                                            if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err ? err.message : 'Error desconocido' }); });
                                            connection.release();
                                            registrarAuditoria(idCajero, 'AÑADIR', 'Comprobante_Pago', `Comprobante ${correlativo} (${tipoComprobante}) generado para pedido #${id_pedido}`);
                                            registrarAuditoria(idCajero, 'REGISTRO_PAGO', 'Pago', `Pago registrado - Método: ${metodoDB} - Monto: S/${total}`);
                                            res.json({ exito: true, numero_correlativo: correlativo, id_comprobante: result.insertId });
                                        });
                                        return;
                                    }

                                    let updatesPendientes = detalles.length;
                                    let errorDescuento = false;
                                    
                                    detalles.forEach(item => {
                                        connection.query('UPDATE Producto SET stock_actual = stock_actual - ? WHERE id_producto = ?', [item.cantidad, item.id_producto], (err) => {
                                            if (errorDescuento) return;
                                            if (err) {
                                                errorDescuento = true;
                                                return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: 'Error descontando stock' }); });
                                            }
                                            updatesPendientes--;
                                            if (updatesPendientes === 0) {
                                                connection.commit(err => {
                                                    if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err ? err.message : 'Error desconocido' }); });
                                                    connection.release();
                                                    registrarAuditoria(idCajero, 'AÑADIR', 'Comprobante_Pago', `Comprobante ${correlativo} (${tipoComprobante}) generado para pedido #${id_pedido}`);
                                                    registrarAuditoria(idCajero, 'REGISTRO_PAGO', 'Pago', `Pago registrado - Método: ${metodoDB} - Monto: S/${total}`);
                                                    res.json({ exito: true, numero_correlativo: correlativo, id_comprobante: result.insertId });
                                                });
                                            }
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

// ==========================================
// F. RUTAS DE PÁGINAS (Sirve los archivos HTML)
// ==========================================
// Esto le dice a Express que la carpeta "css" y "js" son públicas
// para que el navegador pueda cargar los estilos e íconos
app.use('/css', express.static('css'));
app.use('/js', express.static('js'));

// Cada línea de aquí es una "puerta" que lleva a una página HTML
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/menu', (req, res) => res.sendFile(__dirname + '/menu.html'));
app.get('/registrar-cliente', (req, res) => res.sendFile(__dirname + '/registrar-cliente.html'));
app.get('/registrar-pedido', (req, res) => res.sendFile(__dirname + '/registrar-pedido.html'));
app.get('/confirmar-pedido', (req, res) => res.sendFile(__dirname + '/confirmar-pedido.html'));
app.get('/procesar-pago', (req, res) => res.sendFile(__dirname + '/procesar-pago.html'));
app.get('/menu-admin', (req, res) => res.sendFile(__dirname + '/menu-admin.html'));
app.get('/recuperar-contrasena', (req, res) => res.sendFile(__dirname + '/recuperar-contrasena.html'));

// ==========================================
// ENDPOINTS DE RECUPERACIÓN DE CONTRASEÑA
// ==========================================

// PASO 1: Verificar correo y enviar código
app.post('/api/solicitar-codigo', async (req, res) => {
    const { correo } = req.body;
    if (!correo) return res.status(400).json({ exito: false, mensaje: 'Correo requerido.' });

    db.query('SELECT id_usuario, nombre_completo FROM Usuario WHERE correo = ? AND is_active = 1', [correo], async (err, rows) => {
        if (err) return res.status(500).json({ exito: false, mensaje: 'Error interno.' });
        if (rows.length === 0) {
            return res.status(404).json({ exito: false, mensaje: 'No existe ningún usuario con ese correo registrado.' });
        }

        const usuario = rows[0];
        const codigo = String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
        const expira = Date.now() + 15 * 60 * 1000; // 15 minutos

        codigosRecuperacion.set(correo, { codigo, expira, id_usuario: usuario.id_usuario });

        const mailOptions = {
            from: `"Book Center" <${process.env.EMAIL_USER}>`,
            to: correo,
            subject: '🔑 Código de verificación — Book Center',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                    <div style="background: #1e40af; padding: 24px; text-align: center;">
                        <h2 style="color: white; margin: 0; font-size: 20px;">📚 Book Center</h2>
                        <p style="color: #bfdbfe; margin: 4px 0 0 0; font-size: 13px;">Sistema de Librería</p>
                    </div>
                    <div style="padding: 32px 24px;">
                        <p style="color: #1e293b; font-size: 15px;">Hola, <strong>${usuario.nombre_completo}</strong>.</p>
                        <p style="color: #475569; font-size: 14px;">Recibimos una solicitud para restablecer tu contraseña. Usa el siguiente código de verificación:</p>
                        <div style="background: #f1f5f9; border-radius: 10px; padding: 24px; text-align: center; margin: 24px 0;">
                            <span style="font-size: 42px; font-weight: 900; letter-spacing: 8px; color: #1e40af; font-family: monospace;">${codigo}</span>
                        </div>
                        <p style="color: #64748b; font-size: 13px;">⏱️ Este código expira en <strong>15 minutos</strong>.</p>
                        <p style="color: #94a3b8; font-size: 12px;">Si no solicitaste restablecer tu contraseña, ignora este correo.</p>
                    </div>
                    <div style="background: #f8fafc; padding: 16px; text-align: center; border-top: 1px solid #e2e8f0;">
                        <p style="color: #94a3b8; font-size: 11px; margin: 0;">Book Center © 2026 — No responder este correo</p>
                    </div>
                </div>
            `
        };

        try {
            await transporter.sendMail(mailOptions);
            res.json({ exito: true, mensaje: 'Código enviado al correo.' });
        } catch (emailErr) {
            console.error('❌ Error enviando email:', emailErr);
            res.status(500).json({ exito: false, mensaje: 'No se pudo enviar el correo. Intente más tarde.' });
        }
    });
});

// PASO 2: Verificar código ingresado
app.post('/api/verificar-codigo', (req, res) => {
    const { correo, codigo } = req.body;
    if (!correo || !codigo) return res.status(400).json({ exito: false, mensaje: 'Datos incompletos.' });

    const registro = codigosRecuperacion.get(correo);
    if (!registro) return res.status(400).json({ exito: false, mensaje: 'No hay ninguna solicitud activa para ese correo.' });
    if (Date.now() > registro.expira) {
        codigosRecuperacion.delete(correo);
        return res.status(400).json({ exito: false, mensaje: 'El código ha expirado. Solicita uno nuevo.' });
    }
    if (registro.codigo !== String(codigo).trim()) {
        return res.status(400).json({ exito: false, mensaje: 'Código incorrecto. Verifica e intenta de nuevo.' });
    }

    res.json({ exito: true, mensaje: 'Código verificado correctamente.' });
});

// PASO 3: Cambiar la contraseña
app.post('/api/cambiar-contrasena', async (req, res) => {
    const { correo, codigo, nuevaContrasena } = req.body;
    if (!correo || !codigo || !nuevaContrasena) return res.status(400).json({ exito: false, mensaje: 'Datos incompletos.' });

    const registro = codigosRecuperacion.get(correo);
    if (!registro) return res.status(400).json({ exito: false, mensaje: 'Sesión expirada. Inicia el proceso nuevamente.' });
    if (Date.now() > registro.expira || registro.codigo !== String(codigo).trim()) {
        codigosRecuperacion.delete(correo);
        return res.status(400).json({ exito: false, mensaje: 'Código inválido o expirado.' });
    }

    // Política: mín 8 chars, 1 mayúscula, 1 número, 1 especial
    const politica = /^(?=.*[A-Z])(?=.*\d)(?=.*[#@!$%^&*()_+\-=\[\]{};':"|,.<>\/?]).{8,}$/;
    if (!politica.test(nuevaContrasena)) {
        return res.status(400).json({ exito: false, mensaje: 'La contraseña no cumple los requisitos de seguridad.' });
    }

    try {
        const hash = await bcrypt.hash(nuevaContrasena, 10);
        db.query('UPDATE Usuario SET password_hash = ? WHERE id_usuario = ?', [hash, registro.id_usuario], (err) => {
            if (err) return res.status(500).json({ exito: false, mensaje: 'Error al actualizar la contraseña.' });
            codigosRecuperacion.delete(correo); // Limpiar el código una vez usado
            registrarAuditoria(registro.id_usuario, 'CAMBIO_CONTRASENA', 'Usuario', 'Contraseña restablecida vía correo electrónico');
            res.json({ exito: true, mensaje: '¡Contraseña actualizada correctamente!' });
        });
    } catch (e) {
        res.status(500).json({ exito: false, mensaje: 'Error procesando la contraseña.' });
    }
});

// ==========================================
// F. ENCENDIDO DEL SERVIDOR
// ==========================================
// Le decimos a Node que use el puerto que Render le dé, o el 3000 si estás en tu PC
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor de Book Center corriendo en el puerto ${PORT}`));
