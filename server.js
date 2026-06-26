require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

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
    host: 'mysql-955eb71-bookcenter27.b.aivencloud.com',
    user: 'avnadmin',
    password: process.env.AIVEN_PASSWORD,
    port: 22639,
    database: 'defaultdb',
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
    
    // 👇 ESTOS DOS CONSOLE.LOG SON LOS DETECTIVES 👇
    console.log("INTENTO DE LOGIN -> Usuario:", username, "| Contraseña:", password);

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

        console.log("🔍 RESULTADO BASE DE DATOS:", results);

        if (results.length === 0) {
            return res.status(401).json({ exito: false, mensaje: "Usuario no encontrado" });
        }

        const usuario = results[0];

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
            CONCAT_WS(' ', nombres, apellido_paterno, apellido_materno) AS nombre, 
            tipo_documento, 
            numero_documento AS num_documento, 
            telefono, 
            correo 
        FROM Cliente
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
// E. ENCENDIDO DEL SERVIDOR
// ==========================================
// Le decimos a Node que use el puerto que Render le dé, o el 3000 si estás en tu PC
const PORT = process.env.PORT || 3000;
// ==========================================
// RUTA TEMPORAL PARA ACTUALIZAR BASE DE DATOS
// ==========================================
app.get('/api/setup-db', (req, res) => {
    // 1. Creamos la columna
    const sqlCrearColumna = "ALTER TABLE Usuario ADD COLUMN nombre_completo VARCHAR(150) NOT NULL DEFAULT 'Usuario del Sistema' AFTER username;";
    
    db.query(sqlCrearColumna, (err) => {
        // Si hay error, probablemente es porque la columna ya se creó antes. Lo ignoramos y seguimos.
        
        // 2. Le asignamos tu nombre real al admin1
        const sqlActualizarNombre = "UPDATE Usuario SET nombre_completo = 'Diego Sebastián' WHERE id_usuario = 1;";
        
        db.query(sqlActualizarNombre, (err2) => {
            if(err2) return res.send("Hubo un error al actualizar los nombres: " + err2);
            res.send("<h1 style='color: green; font-family: sans-serif;'>✅ ¡Base de datos actualizada con éxito!</h1><p style='font-family: sans-serif;'>Ya puedes cerrar esta pestaña y volver a tu Login.</p>");
        });
    });
});
app.listen(PORT, () => console.log(`🚀 Servidor de Book Center corriendo en el puerto ${PORT}`));