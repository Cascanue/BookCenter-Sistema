require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const bcrypt = require('bcrypt');

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

        connection.query(sqlCrear, () => {
            connection.query(sqlActualizar, () => {
                console.log('🌟 ¡LISTO! Base de datos actualizada con tu nombre. Ya puedes iniciar sesión.');
                connection.release();
            });
        });
    }
});

// ==========================================
// C. RUTAS DEL SISTEMA (Endpoints)
// ==========================================

// 1. RUTA DE LOGIN (Verifica credenciales y rol)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    // Log de intento de login
    console.log("INTENTO DE LOGIN -> Usuario:", username);

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
            return res.status(401).json({ exito: false, mensaje: "Usuario no encontrado" });
        }

        const usuario = results[0];

        // Retornamos a la validación clásica (texto plano)
        // Ya no usamos bcrypt porque la base de datos no está encriptada aún
        if (password !== usuario.password_hash) {
            return res.status(401).json({ exito: false, mensaje: "Contraseña incorrecta" });
        }

        res.json({
            exito: true,
            usuario: {
                id_usuario: usuario.id_usuario,
                username: usuario.username,
                nombre_completo: usuario.nombre_completo,
                nombre_rol: usuario.nombre_rol
            }
        });
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

            // PASO A: Insertar la cabecera en la tabla Pedido
            const queryPedido = `INSERT INTO Pedido (id_cliente, id_usuario, total, estado) VALUES (?, ?, ?, 'Pendiente')`;

            connection.query(queryPedido, [id_cliente, id_usuario, total], (err, resultPedido) => {
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
app.post('/api/productos', (req, res) => {
    const { codigo, nombre, descripcion, precio_venta, stock_actual, stock_minimo, id_categoria } = req.body;
    const query = 'INSERT INTO Producto (codigo, nombre, descripcion, precio_venta, stock_actual, stock_minimo, id_categoria, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)';
    db.query(query, [codigo, nombre, descripcion, precio_venta, stock_actual, stock_minimo, id_categoria], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ exito: true });
    });
});
app.put('/api/productos/:id', (req, res) => {
    const { codigo, nombre, descripcion, precio_venta, stock_actual, stock_minimo, id_categoria } = req.body;
    const query = 'UPDATE Producto SET codigo=?, nombre=?, descripcion=?, precio_venta=?, stock_actual=?, stock_minimo=?, id_categoria=? WHERE id_producto=?';
    db.query(query, [codigo, nombre, descripcion, precio_venta, stock_actual, stock_minimo, id_categoria, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ exito: true });
    });
});
app.delete('/api/productos/:id', (req, res) => {
    db.query('UPDATE Producto SET is_active = 0 WHERE id_producto = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ exito: true });
    });
});

// 9. CLIENTES (Actualizar y Eliminar Lógico)
app.put('/api/clientes/:id', (req, res) => {
    const { tipo_documento, numero_documento, nombres, apellido_paterno, apellido_materno, telefono, correo } = req.body;
    const query = 'UPDATE Cliente SET tipo_documento=?, numero_documento=?, nombres=?, apellido_paterno=?, apellido_materno=?, telefono=?, correo=? WHERE id_cliente=?';
    db.query(query, [tipo_documento, numero_documento, nombres, apellido_paterno, apellido_materno, telefono, correo, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ exito: true });
    });
});
app.delete('/api/clientes/:id', (req, res) => {
    db.query('UPDATE Cliente SET is_active = 0 WHERE id_cliente = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ exito: true });
    });
});

// 10. PEDIDOS E HISTORIAL
app.get('/api/admin/pedidos', (req, res) => {
    const query = `
        SELECT p.id_pedido, c.nombres, c.apellido_paterno, p.fecha_pedido, p.total, p.estado 
        FROM Pedido p 
        LEFT JOIN Cliente c ON p.id_cliente = c.id_cliente 
        ORDER BY p.id_pedido DESC
    `;
    db.query(query, (err, results) => {
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

// 11. COMPROBANTES Y ANULACIONES
app.get('/api/admin/comprobantes', (req, res) => {
    const query = `
        SELECT cp.id_comprobante, cp.numero_correlativo, cp.tipo_comprobante, cp.fecha_emision, cp.monto_total, p.id_pedido, p.estado 
        FROM Comprobante_Pago cp 
        JOIN Pedido p ON cp.id_pedido = p.id_pedido 
        ORDER BY cp.id_comprobante DESC
    `;
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});
app.put('/api/admin/comprobantes/:id/anular', (req, res) => {
    // Al anular, pasamos el estado del pedido a 'Anulado'
    const query = 'UPDATE Pedido SET estado = "Anulado" WHERE id_pedido = (SELECT id_pedido FROM Comprobante_Pago WHERE id_comprobante = ?)';
    db.query(query, [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ exito: true });
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

// ==========================================
// F. ENCENDIDO DEL SERVIDOR
// ==========================================
// Le decimos a Node que use el puerto que Render le dé, o el 3000 si estás en tu PC
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor de Book Center corriendo en el puerto ${PORT}`));
