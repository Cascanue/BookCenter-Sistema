require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'bookcenter-secreto-dev';
const JWT_EXPIRACION = '8h'; // un turno de trabajo
const FECHA_MIN_SISTEMA = '2026-04-01';

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
        connection.release();
        // Los cambios de esquema NO viven aquí: ver migracion_multisede.sql
        // y ejecutar `node scripts/migrar-multisede.js`.
    }
});

// ==========================================
// CONFIGURACIÓN DE NODEMAILER (Gmail)
// ==========================================
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // true for 465, false for 587
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
// SEGURIDAD: AUTENTICACIÓN JWT (Fase 1 · A2)
// ==========================================
// Rutas de API que NO requieren token (login, recuperación de contraseña
// y el webhook que Mercado Pago invoca desde sus servidores).
const RUTAS_PUBLICAS = [
    '/api/ping',
    '/api/login',
    '/api/solicitar-codigo',
    '/api/verificar-codigo',
    '/api/cambiar-contrasena',
    '/api/webhook-mp'
];

app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') || RUTAS_PUBLICAS.includes(req.path)) return next();

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) {
        return res.status(401).json({ exito: false, codigo: 'TOKEN_INVALIDO', mensaje: 'Sesión no válida. Inicia sesión nuevamente.' });
    }

    try {
        // Payload: { id_usuario, id_rol, nombre_rol, id_sede }
        req.usuario = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ exito: false, codigo: 'TOKEN_INVALIDO', mensaje: 'Sesión expirada. Inicia sesión nuevamente.' });
    }
});

const esAdmin = (req) => ((req.usuario && req.usuario.nombre_rol) || '').toLowerCase() === 'administrador';

// Las rutas /api/admin/* y /api/roles son exclusivas del Administrador
app.use((req, res, next) => {
    if ((req.path.startsWith('/api/admin/') || req.path === '/api/roles') && !esAdmin(req)) {
        return res.status(403).json({ exito: false, mensaje: 'Acceso restringido a administradores.' });
    }
    next();
});

// Sede efectiva para una consulta: los empleados quedan amarrados a la sede
// de su token; el administrador puede pedir ?sede=N o nada (todas las sedes).
function sedeDeConsulta(req) {
    if (esAdmin(req)) {
        const s = parseInt(req.query.sede);
        return Number.isInteger(s) ? s : null;
    }
    return req.usuario.id_sede || 1;
}

function fechaHoyISOPeru() {
    return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function fechaISOValida(valor) {
    if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
    const fecha = new Date(`${valor}T00:00:00`);
    return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === valor;
}

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

// PING público: lo usa el login para despertar el servidor de Render
// antes de que el usuario envíe sus credenciales (reduce la demora).
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// ==========================================
// MP. MERCADO PAGO — Generar QR Dinámico
// ==========================================
app.post('/api/generar-qr', async (req, res) => {
    try {
        const { id_pedido, total, descripcion } = req.body;
        const accessToken = process.env.MP_ACCESS_TOKEN;

        if (!accessToken) {
            return res.status(500).json({ exito: false, mensaje: 'MP_ACCESS_TOKEN no configurado en el servidor.' });
        }

        // Crear preferencia de pago en Mercado Pago
        const preferenceRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                items: [{
                    title: descripcion || `Book Center — Pedido #${id_pedido}`,
                    quantity: 1,
                    unit_price: parseFloat(total),
                    currency_id: 'PEN'
                }],
                external_reference: `PEDIDO-${id_pedido}`,
                notification_url: 'https://bookcenter-backend.onrender.com/api/webhook-mp'
            })
        });

        const preference = await preferenceRes.json();

        if (!preference.id) {
            console.error('MP Error:', preference);
            return res.status(500).json({ exito: false, mensaje: 'No se pudo crear la preferencia en MP: ' + (preference.message || JSON.stringify(preference)) });
        }

        // Generar imagen QR del link de pago usando servicio público
        const qrData = preference.sandbox_init_point || preference.init_point;
        const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&format=png&data=${encodeURIComponent(qrData)}`;

        const qrRes = await fetch(qrApiUrl);
        const qrBuffer = await qrRes.arrayBuffer();
        const qrBase64 = Buffer.from(qrBuffer).toString('base64');

        res.json({
            exito: true,
            qr_id: preference.id,
            qr_image_base64: qrBase64,
            init_point: qrData
        });

    } catch (err) {
        console.error('❌ Error generando QR MP:', err);
        res.status(500).json({ exito: false, mensaje: 'Error interno: ' + err.message });
    }
});

// MP Webhook — recibe notificaciones de pago de Mercado Pago
app.post('/api/webhook-mp', (req, res) => {
    console.log('📩 Webhook MP recibido:', JSON.stringify(req.body));
    res.sendStatus(200);
});

// Polling MP — verifica si un pedido específico ya fue pagado
app.get('/api/verificar-pago-mp/:id_pedido', async (req, res) => {
    try {
        const { id_pedido } = req.params;
        const accessToken = process.env.MP_ACCESS_TOKEN;
        
        if (!accessToken) return res.json({ pagado: false });

        const searchRes = await fetch(`https://api.mercadopago.com/v1/payments/search?external_reference=PEDIDO-${id_pedido}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        const data = await searchRes.json();
        
        if (data.results && data.results.length > 0) {
            // Buscar si hay algún pago aprobado para esta referencia
            const pagoAprobado = data.results.find(p => p.status === 'approved');
            if (pagoAprobado) {
                return res.json({ pagado: true, numOperacion: pagoAprobado.id });
            }
        }
        
        res.json({ pagado: false });
    } catch (err) {
        console.error('❌ Error en polling MP:', err);
        res.json({ pagado: false });
    }
});

// 1. RUTA DE LOGIN (Verifica credenciales y rol, emite JWT con la sede)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    const query = `
        SELECT u.id_usuario, u.username, u.nombre_completo, u.password_hash, u.id_rol, r.nombre_rol,
               u.id_sede, s.nombre AS nombre_sede, s.codigo_sede
        FROM Usuario u
        INNER JOIN Rol r ON u.id_rol = r.id_rol
        LEFT JOIN Sede s ON u.id_sede = s.id_sede
        WHERE u.username = ? AND u.is_active = TRUE
    `;

    // CU-01: mensaje único para no revelar si el usuario existe o no
    const MENSAJE_CREDENCIALES = 'Usuario o contraseña incorrectos';

    db.query(query, [username], (err, results) => {
        if (err) {
            console.error("❌ ERROR SQL:", err);
            return res.status(500).json({ exito: false, mensaje: "Error interno del servidor" });
        }

        if (results.length === 0) {
            registrarAuditoria(null, 'LOGIN_FALLIDO', 'Usuario', `Usuario inexistente: ${username}`);
            return res.status(401).json({ exito: false, mensaje: MENSAJE_CREDENCIALES });
        }

        const usuario = results[0];
        const hashGuardado = usuario.password_hash;
        const yaEncriptada = typeof hashGuardado === 'string' && hashGuardado.startsWith('$2');

        const continuarConResultado = (coincide) => {
            if (!coincide) {
                registrarAuditoria(usuario.id_usuario, 'LOGIN_FALLIDO', 'Usuario', `Contraseña incorrecta para: ${usuario.username}`);
                return res.status(401).json({ exito: false, mensaje: MENSAJE_CREDENCIALES });
            }

            const token = jwt.sign(
                {
                    id_usuario: usuario.id_usuario,
                    id_rol: usuario.id_rol,
                    nombre_rol: usuario.nombre_rol,
                    id_sede: usuario.id_sede || null
                },
                JWT_SECRET,
                { expiresIn: JWT_EXPIRACION }
            );

            registrarAuditoria(usuario.id_usuario, 'LOGIN_EXITOSO', 'Usuario', `Inicio de sesión: ${usuario.username}`);
            res.json({
                exito: true,
                token,
                usuario: {
                    id_usuario: usuario.id_usuario,
                    username: usuario.username,
                    nombre_completo: usuario.nombre_completo,
                    id_rol: usuario.id_rol,
                    nombre_rol: usuario.nombre_rol,
                    id_sede: usuario.id_sede || null,
                    nombre_sede: usuario.nombre_sede || null,
                    codigo_sede: usuario.codigo_sede || null
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

// 2. RUTA REGISTRAR CLIENTE (los clientes son universales: sin sede)
app.post('/api/registrar-cliente', (req, res) => {
    const { tipoDoc, numDoc, nombres, apellidoPaterno, apellidoMaterno, telefono, correo } = req.body;
    // El creador sale del token (más confiable que el body)
    const idCreador = req.usuario.id_usuario;

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
// El admin recibe todas (para su panel de gestión); los empleados solo las activas.
app.get('/api/categorias', (req, res) => {
    const query = esAdmin(req)
        ? 'SELECT id_categoria, nombre, icono, is_active FROM Categoria ORDER BY id_categoria'
        : 'SELECT id_categoria, nombre, icono FROM Categoria WHERE is_active = 1 ORDER BY id_categoria';

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al obtener categorías:', err);
            return res.status(500).json({ error: 'Error al obtener categorías' });
        }
        res.json(results);
    });
});

// 4. OBTENER PRODUCTOS (catálogo global + stock de la sede correspondiente)
// Empleado → stock de SU sede. Admin con ?sede=N → esa sede.
// Admin sin sede → stock total sumado de todas las sedes (solo lectura).
app.get('/api/productos', (req, res) => {
    const sede = sedeDeConsulta(req);
    let query, params;

    if (sede !== null) {
        query = `
            SELECT p.id_producto, p.codigo, p.nombre, p.descripcion, p.id_categoria, p.url_imagen, p.precio_venta,
                   COALESCE(i.stock_actual, 0) AS stock_actual,
                   COALESCE(i.stock_minimo, 5) AS stock_minimo
            FROM Producto p
            LEFT JOIN Inventario_Sede i ON i.id_producto = p.id_producto AND i.id_sede = ?
            WHERE p.is_active = 1
        `;
        params = [sede];
    } else {
        // Vista global: el stock es la suma de todas las sedes, pero el mínimo
        // de referencia es el MAYOR mínimo por sede (sumarlos inflaba el umbral
        // y marcaba como críticos productos con stock de sobra).
        // CAST: SUM() devuelve DECIMAL y mysql2 lo entrega como texto, lo que
        // rompía las comparaciones numéricas en el frontend.
        query = `
            SELECT p.id_producto, p.codigo, p.nombre, p.descripcion, p.id_categoria, p.url_imagen, p.precio_venta,
                   CAST(COALESCE(SUM(i.stock_actual), 0) AS SIGNED) AS stock_actual,
                   CAST(COALESCE(MAX(i.stock_minimo), 0) AS SIGNED) AS stock_minimo
            FROM Producto p
            LEFT JOIN Inventario_Sede i ON i.id_producto = p.id_producto
            WHERE p.is_active = 1
            GROUP BY p.id_producto
        `;
        params = [];
    }

    db.query(query, params, (err, results) => {
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
    const { id_cliente, total, detalles } = req.body;
    // Identidad y sede salen del token, no del body (seguridad multi-sede).
    // Un admin sin sede asignada registra en la sede 1 por defecto.
    const id_usuario = req.usuario.id_usuario;
    const id_sede = req.usuario.id_sede || 1;

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

            // El stock ahora vive en Inventario_Sede: validamos contra la sede del pedido
            const queryStock = `
                SELECT p.id_producto, COALESCE(i.stock_actual, 0) AS stock_actual, p.nombre
                FROM Producto p
                LEFT JOIN Inventario_Sede i ON i.id_producto = p.id_producto AND i.id_sede = ?
                WHERE p.id_producto IN (?)
            `;
            connection.query(queryStock, [id_sede, productoIds], (err, resultsStock) => {
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
                const queryPedido = `INSERT INTO Pedido (id_cliente, id_usuario, id_sede, total, estado, fecha_pedido) VALUES (?, ?, ?, ?, 'Pendiente', ?)`;

                connection.query(queryPedido, [id_cliente, id_usuario, id_sede, total, fechaPeru], (err, resultPedido) => {
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

// 7. OBTENER RESUMEN (KPIs) — acepta ?sede=N; sin sede = todo el negocio
app.get('/api/admin/resumen', async (req, res) => {
    try {
        const sede = sedeDeConsulta(req);
        const p = db.promise();
        const [[{ totalProductos }]] = await p.query('SELECT COUNT(*) as totalProductos FROM Producto WHERE is_active = 1');
        const [[{ totalClientes }]] = await p.query('SELECT COUNT(*) as totalClientes FROM Cliente WHERE is_active = 1');

        const [[{ totalPedidos }]] = sede !== null
            ? await p.query('SELECT COUNT(*) as totalPedidos FROM Pedido WHERE id_sede = ?', [sede])
            : await p.query('SELECT COUNT(*) as totalPedidos FROM Pedido');

        // Mismo criterio que GET /api/productos: por sede compara la fila de esa
        // sede; global compara la suma de stock contra el MAYOR mínimo por sede
        // (sumar los mínimos inflaba el umbral y disparaba falsas alertas).
        const filtroSede = sede !== null ? 'AND i.id_sede = ?' : '';
        const paramsCritico = sede !== null ? [sede] : [];
        const criterio = sede !== null
            ? 'HAVING SUM(i.stock_actual) <= SUM(i.stock_minimo)'
            : 'HAVING SUM(i.stock_actual) <= MAX(i.stock_minimo)';
        const [[{ stockCritico }]] = await p.query(`
            SELECT COUNT(*) as stockCritico FROM (
                SELECT i.id_producto
                FROM Inventario_Sede i
                JOIN Producto pr ON pr.id_producto = i.id_producto AND pr.is_active = 1
                WHERE 1=1 ${filtroSede}
                GROUP BY i.id_producto
                ${criterio}
            ) t
        `, paramsCritico);

        res.json({ totalProductos, totalClientes, totalPedidos, stockCritico });
    } catch (err) {
        console.error('Error KPIs:', err);
        res.status(500).json({ error: 'Error obteniendo KPIs' });
    }
});

// 8. CRUD PRODUCTOS
app.post('/api/productos', async (req, res) => {
    try {
        const { nombre, descripcion, precio_venta, stock_actual, stock_minimo, id_categoria, url_imagen, id_sede } = req.body;
        const id_usuario = req.usuario.id_usuario;
        const p = db.promise();

        // RN-07 / CU-04: el precio no puede ser cero y el nombre no puede duplicarse
        if (!(parseFloat(precio_venta) > 0)) {
            return res.status(400).json({ exito: false, mensaje: 'El precio de venta no puede ser cero.' });
        }
        const [[duplicado]] = await p.query(
            'SELECT id_producto FROM Producto WHERE is_active = 1 AND LOWER(nombre) = LOWER(?)',
            [nombre]
        );
        if (duplicado) {
            return res.status(400).json({ exito: false, mensaje: 'El producto ya existe: hay otro producto activo con ese nombre.' });
        }

        // 1. Obtener la categoría para generar el prefijo
        const [[categoria]] = await p.query('SELECT nombre FROM Categoria WHERE id_categoria = ?', [id_categoria]);
        if (!categoria) return res.status(400).json({ exito: false, mensaje: 'Categoría no válida' });

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

        // 4. Guardar el catálogo (sin stock: el stock vive en Inventario_Sede)
        const query = 'INSERT INTO Producto (codigo, nombre, descripcion, precio_venta, id_categoria, url_imagen, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)';
        const [insercion] = await p.query(query, [nuevoCodigo, nombre, descripcion, precio_venta, id_categoria, url_imagen || null]);

        // 5. Crear inventario en TODAS las sedes activas: el stock inicial va a la
        //    sede indicada (o a la del usuario / sede 1) y el resto arranca en 0.
        const idProducto = insercion.insertId;
        const sedeInicial = parseInt(id_sede) || req.usuario.id_sede || 1;
        const [sedesActivas] = await p.query('SELECT id_sede FROM Sede WHERE is_active = 1');
        if (sedesActivas.length > 0) {
            const filas = sedesActivas.map(s => [
                idProducto, s.id_sede,
                s.id_sede === sedeInicial ? (parseInt(stock_actual) || 0) : 0,
                parseInt(stock_minimo) || 5
            ]);
            await p.query('INSERT INTO Inventario_Sede (id_producto, id_sede, stock_actual, stock_minimo) VALUES ?', [filas]);
        }

        registrarAuditoria(id_usuario || null, 'AÑADIR', 'Producto', `Producto creado: ${nuevoCodigo} - ${nombre} (stock inicial en sede ${sedeInicial})`);
        res.json({ exito: true, codigo_generado: nuevoCodigo });
    } catch (err) {
        console.error('Error generando producto:', err);
        res.status(500).json({ exito: false, mensaje: 'Error al crear producto' });
    }
});
app.put('/api/productos/:id', async (req, res) => {
    try {
        const { nombre, descripcion, precio_venta, stock_actual, stock_minimo, id_categoria, url_imagen, id_sede } = req.body;
        const id_usuario = req.usuario.id_usuario;
        const p = db.promise();

        if (!(parseFloat(precio_venta) > 0)) {
            return res.status(400).json({ exito: false, mensaje: 'El precio de venta no puede ser cero.' });
        }
        const [[duplicado]] = await p.query(
            'SELECT id_producto FROM Producto WHERE is_active = 1 AND LOWER(nombre) = LOWER(?) AND id_producto <> ?',
            [nombre, req.params.id]
        );
        if (duplicado) {
            return res.status(400).json({ exito: false, mensaje: 'Ya existe otro producto activo con ese nombre.' });
        }

        // Datos de catálogo (globales, iguales en todas las sedes)
        await p.query(
            'UPDATE Producto SET nombre=?, descripcion=?, precio_venta=?, id_categoria=?, url_imagen=? WHERE id_producto=?',
            [nombre, descripcion, precio_venta, id_categoria, url_imagen || null, req.params.id]
        );

        // Stock: SOLO se toca si la petición indica una sede concreta.
        // (El panel admin envía id_sede cuando hay una sede seleccionada;
        //  en la vista "Todas las Sedes" el stock mostrado es la suma y no se edita.)
        const sedeStock = parseInt(id_sede) || req.usuario.id_sede || null;
        if (sedeStock !== null) {
            await p.query(`
                INSERT INTO Inventario_Sede (id_producto, id_sede, stock_actual, stock_minimo)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE stock_actual = VALUES(stock_actual), stock_minimo = VALUES(stock_minimo)
            `, [req.params.id, sedeStock, parseInt(stock_actual) || 0, parseInt(stock_minimo) || 5]);
        }

        registrarAuditoria(id_usuario || null, 'MODIFICAR', 'Producto', `Producto actualizado: id ${req.params.id} - ${nombre}` + (sedeStock ? ` (stock en sede ${sedeStock})` : ' (solo catálogo)'));
        res.json({ exito: true });
    } catch (err) {
        console.error('Error actualizando producto:', err);
        res.status(500).json({ exito: false, mensaje: 'Error al actualizar producto' });
    }
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
    // CU-04: no se puede eliminar un producto que pertenece a un pedido en curso
    const queryEnCurso = `
        SELECT COUNT(*) AS n
        FROM Detalle_Pedido dp
        JOIN Pedido pe ON pe.id_pedido = dp.id_pedido
        WHERE dp.id_producto = ? AND pe.estado = 'Pendiente'
    `;
    db.query(queryEnCurso, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ exito: false, mensaje: err.message });
        if (rows[0].n > 0) {
            return res.status(400).json({ exito: false, mensaje: 'Operación denegada: el producto pertenece a un pedido en curso.' });
        }

        db.query('UPDATE Producto SET is_active = 0 WHERE id_producto = ?', [req.params.id], (err) => {
            if (err) return res.status(500).json({ exito: false, mensaje: err.message });
            registrarAuditoria(req.usuario.id_usuario, 'ELIMINAR', 'Producto', `Producto eliminado (baja lógica): id ${req.params.id}`);
            res.json({ exito: true });
        });
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

// 10. PEDIDOS E HISTORIAL (con sede; acepta ?sede=N)
app.get('/api/admin/pedidos', (req, res) => {
    const { estado, fecha } = req.query;
    const sede = sedeDeConsulta(req);
    let query = `
        SELECT p.id_pedido, c.nombres, c.apellido_paterno, p.fecha_pedido, p.total, p.estado,
               p.id_sede, s.nombre AS nombre_sede
        FROM Pedido p
        LEFT JOIN Cliente c ON p.id_cliente = c.id_cliente
        LEFT JOIN Sede s ON p.id_sede = s.id_sede
        WHERE 1=1
    `;
    const params = [];
    if (estado) { query += ' AND p.estado = ?'; params.push(estado); }
    if (fecha) { query += ' AND DATE(p.fecha_pedido) = ?'; params.push(fecha); }
    if (sede !== null) { query += ' AND p.id_sede = ?'; params.push(sede); }
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

// Mantenimiento de Pedidos (CU-08): editar estado / ANULAR pedido.
// La anulación es lógica (estado 'Anulado' + motivo); ya no existe DELETE físico.
app.put('/api/admin/pedidos/:id', (req, res) => {
    const { estado, motivo } = req.body;
    const id_usuario = req.usuario.id_usuario;
    const estadosValidos = ['Pendiente', 'Completado', 'Anulado'];
    if (!estadosValidos.includes(estado)) {
        return res.status(400).json({ exito: false, mensaje: 'Estado no válido' });
    }

    db.query('SELECT estado FROM Pedido WHERE id_pedido = ?', [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ exito: false, mensaje: err.message });
        if (rows.length === 0) return res.status(404).json({ exito: false, mensaje: 'Pedido no encontrado' });

        if (estado === 'Anulado') {
            if (!motivo || !motivo.trim()) {
                return res.status(400).json({ exito: false, mensaje: 'Debes indicar el motivo de la anulación' });
            }
            if (rows[0].estado !== 'Pendiente') {
                return res.status(400).json({ exito: false, mensaje: 'Solo se pueden anular pedidos en estado Pendiente' });
            }
            return db.query(
                'UPDATE Pedido SET estado = "Anulado", motivo_anulacion = ? WHERE id_pedido = ?',
                [motivo.trim(), req.params.id],
                (err) => {
                    if (err) return res.status(500).json({ exito: false, mensaje: err.message });
                    registrarAuditoria(id_usuario, 'ELIMINAR', 'Pedido', `Pedido #${req.params.id} anulado - Motivo: ${motivo.trim()}`);
                    res.json({ exito: true });
                }
            );
        }

        // Cambio de estado excepcional del administrador (queda en auditoría)
        db.query('UPDATE Pedido SET estado = ? WHERE id_pedido = ?', [estado, req.params.id], (err, result) => {
            if (err) return res.status(500).json({ exito: false, mensaje: err.message });
            registrarAuditoria(id_usuario, 'MODIFICAR', 'Pedido', `Pedido #${req.params.id} actualizado a estado: ${estado}`);
            res.json({ exito: true });
        });
    });
});

// 11. COMPROBANTES Y ANULACIONES (con sede y estado propio del comprobante)
app.get('/api/admin/comprobantes', (req, res) => {
    const { estado, fecha } = req.query;
    const sede = sedeDeConsulta(req);
    let query = `
        SELECT cp.id_comprobante, cp.numero_correlativo, cp.tipo_comprobante, cp.fecha_emision, cp.monto_total,
               cp.igv, cp.motivo_anulacion,
               p.id_pedido, p.estado AS estado_pedido,
               cp.estado_comprobante AS estado,
               cp.id_sede, s.nombre AS nombre_sede, s.direccion AS direccion_sede,
               c.nombres, c.apellido_paterno, c.apellido_materno, c.tipo_documento, c.numero_documento
        FROM Comprobante_Pago cp
        JOIN Pedido p ON cp.id_pedido = p.id_pedido
        LEFT JOIN Cliente c ON p.id_cliente = c.id_cliente
        LEFT JOIN Sede s ON cp.id_sede = s.id_sede
        WHERE 1=1
    `;
    const params = [];
    if (estado) { query += ' AND cp.estado_comprobante = ?'; params.push(estado); }
    if (fecha) { query += ' AND DATE(cp.fecha_emision) = ?'; params.push(fecha); }
    if (sede !== null) { query += ' AND cp.id_sede = ?'; params.push(sede); }
    query += ' ORDER BY cp.id_comprobante DESC';

    db.query(query, params, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// Anular comprobante (CU-07): guarda el motivo, regresa el pedido a "Pendiente"
// y devuelve el stock al inventario de la SEDE del pedido
app.put('/api/admin/comprobantes/:id/anular', (req, res) => {
    const { motivo } = req.body;
    const id_usuario = req.usuario.id_usuario;
    if (!motivo || !motivo.trim()) {
        return res.status(400).json({ exito: false, mensaje: 'Debes indicar el motivo de la anulación' });
    }

    db.getConnection((err, connection) => {
        if (err) return res.status(500).json({ exito: false, mensaje: 'Error de conexión a la BD' });

        connection.beginTransaction(err => {
            if (err) { connection.release(); return res.status(500).json({ exito: false, mensaje: 'Error al iniciar transacción' }); }

            connection.query(
                `SELECT cp.id_pedido, cp.estado_comprobante, p.id_sede
                 FROM Comprobante_Pago cp
                 JOIN Pedido p ON p.id_pedido = cp.id_pedido
                 WHERE cp.id_comprobante = ?`,
                [req.params.id],
                (err, rows) => {
                    if (err) return connection.rollback(() => { connection.release(); res.status(500).json({ exito: false, mensaje: err.message }); });
                    if (rows.length === 0) return connection.rollback(() => { connection.release(); res.status(404).json({ exito: false, mensaje: 'Comprobante no encontrado' }); });
                    if (rows[0].estado_comprobante === 'Anulado') {
                        return connection.rollback(() => { connection.release(); res.status(400).json({ exito: false, mensaje: 'El comprobante ya se encuentra anulado' }); });
                    }

                    const idPedido = rows[0].id_pedido;
                    const idSedePedido = rows[0].id_sede || 1;

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
                                        // Upsert por si la fila de inventario no existiera aún en esa sede
                                        connection.query(
                                            `INSERT INTO Inventario_Sede (id_producto, id_sede, stock_actual)
                                             VALUES (?, ?, ?)
                                             ON DUPLICATE KEY UPDATE stock_actual = stock_actual + VALUES(stock_actual)`,
                                            [item.id_producto, idSedePedido, item.cantidad], (err) => {
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
        SELECT p.*, c.nombres, c.apellido_paterno, c.tipo_documento, c.numero_documento,
               s.nombre AS nombre_sede, s.direccion AS direccion_sede, s.codigo_sede
            FROM Pedido p
            INNER JOIN Cliente c ON p.id_cliente = c.id_cliente
            LEFT JOIN Sede s ON p.id_sede = s.id_sede
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

        // Bloqueo de caja cruzada: un cajero solo ve/cobra pedidos de SU sede.
        // El administrador (sin sede) puede consultar cualquiera.
        if (!esAdmin(req) && req.usuario.id_sede && pedidos[0].id_sede && pedidos[0].id_sede !== req.usuario.id_sede) {
            return res.status(403).json({ error: 'Este pedido pertenece a otra sede y no puede cobrarse aquí.' });
        }

        db.query(queryDetalles, [req.params.id], (err, detalles) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ...pedidos[0], detalles });
        });
    });
});

// 13. PROCESAR PAGO (Genera comprobante y actualiza estado)
// Fase 3: transacción con stock atómico por sede, correlativo seguro
// (Correlativo_Sede + FOR UPDATE) y registro fiel del pago (monto real y vuelto).
app.post('/api/procesar-pago', async (req, res) => {
    const { id_pedido, metodo_pago, tipo_documento, monto_recibido } = req.body;
    const idCajero = req.usuario.id_usuario;

    let connection;
    try {
        connection = await db.promise().getConnection();
        await connection.beginTransaction();

        const fallar = (status, mensaje) => {
            const e = new Error(mensaje);
            e.httpStatus = status;
            throw e;
        };

        // 1. Pedido bloqueado (FOR UPDATE) para serializar dos cobros simultáneos
        const [pedidos] = await connection.query(
            'SELECT total, estado, id_sede FROM Pedido WHERE id_pedido = ? FOR UPDATE', [id_pedido]
        );
        if (pedidos.length === 0) fallar(404, 'Pedido no encontrado');
        if (pedidos[0].estado !== 'Pendiente') fallar(400, `El pedido ya tiene estado: ${pedidos[0].estado}`);

        const total = parseFloat(pedidos[0].total);
        const idSede = pedidos[0].id_sede || 1;

        // Bloqueo de caja cruzada: el cajero solo cobra pedidos de su sede
        if (!esAdmin(req) && req.usuario.id_sede && idSede !== req.usuario.id_sede) {
            fallar(403, 'Este pedido pertenece a otra sede y no puede cobrarse aquí.');
        }

        // 2. Pago fiel (CU-06): validar el efectivo recibido y calcular el vuelto
        const metodoDB = metodo_pago === 'billetera' ? 'Billetera Digital' : (metodo_pago === 'tarjeta' ? 'Tarjeta' : 'Efectivo');
        let recibido = total, vuelto = 0;
        if (metodoDB === 'Efectivo') {
            recibido = parseFloat(monto_recibido);
            if (!Number.isFinite(recibido) || recibido < total) {
                fallar(400, 'Monto insuficiente para cubrir el total del pedido.');
            }
            vuelto = parseFloat((recibido - total).toFixed(2));
        }

        // 3. Stock atómico (RN-01/RN-02): descuenta y re-valida en UNA sentencia.
        // Si affectedRows = 0, el stock ya no alcanza (otro pedido lo consumió).
        const [detalles] = await connection.query(
            `SELECT dp.id_producto, dp.cantidad, pr.nombre
             FROM Detalle_Pedido dp
             JOIN Producto pr ON pr.id_producto = dp.id_producto
             WHERE dp.id_pedido = ?`, [id_pedido]
        );
        if (detalles.length === 0) fallar(400, 'El pedido no tiene productos.');

        for (const item of detalles) {
            const [r] = await connection.query(
                `UPDATE Inventario_Sede
                 SET stock_actual = stock_actual - ?
                 WHERE id_producto = ? AND id_sede = ? AND stock_actual >= ?`,
                [item.cantidad, item.id_producto, idSede, item.cantidad]
            );
            if (r.affectedRows === 0) {
                fallar(400, `Stock insuficiente para "${item.nombre}" en esta sede. El pedido debe modificarse antes de cobrarse.`);
            }
        }

        // 4. IGV peruano 18% incluido en el precio
        const igv = parseFloat((total - (total / 1.18)).toFixed(2));

        // 5. Correlativo seguro por sede y tipo (RN-04): contador dedicado + FOR UPDATE
        const tipoComprobante = (tipo_documento === 'RUC') ? 'Factura' : 'Boleta';
        await connection.query(
            'INSERT IGNORE INTO Correlativo_Sede (id_sede, tipo_comprobante, ultimo_numero) VALUES (?, ?, 0)',
            [idSede, tipoComprobante]
        );
        const [[contador]] = await connection.query(
            'SELECT ultimo_numero FROM Correlativo_Sede WHERE id_sede = ? AND tipo_comprobante = ? FOR UPDATE',
            [idSede, tipoComprobante]
        );
        const siguiente = contador.ultimo_numero + 1;
        await connection.query(
            'UPDATE Correlativo_Sede SET ultimo_numero = ? WHERE id_sede = ? AND tipo_comprobante = ?',
            [siguiente, idSede, tipoComprobante]
        );
        const [[sedeInfo]] = await connection.query('SELECT codigo_sede FROM Sede WHERE id_sede = ?', [idSede]);
        const correlativo = `${(sedeInfo && sedeInfo.codigo_sede) || 'SP'}-${String(siguiente).padStart(8, '0')}`;

        // 6. Comprobante (con sede) y pago (monto real, vuelto; fecha_pago por DEFAULT)
        const [resultComp] = await connection.query(
            'INSERT INTO Comprobante_Pago (id_pedido, id_cajero, id_sede, numero_correlativo, tipo_comprobante, monto_total, igv) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [id_pedido, idCajero, idSede, correlativo, tipoComprobante, total, igv]
        );
        await connection.query(
            'INSERT INTO Pago (id_comprobante, metodo_pago, monto_recibido, vuelto) VALUES (?, ?, ?, ?)',
            [resultComp.insertId, metodoDB, recibido, vuelto]
        );

        // 7. Cerrar el ciclo: pedido Completado
        await connection.query("UPDATE Pedido SET estado = 'Completado' WHERE id_pedido = ?", [id_pedido]);

        await connection.commit();

        registrarAuditoria(idCajero, 'AÑADIR', 'Comprobante_Pago', `Comprobante ${correlativo} (${tipoComprobante}) generado para pedido #${id_pedido} en sede ${idSede}`);
        registrarAuditoria(idCajero, 'REGISTRO_PAGO', 'Pago', `Pago registrado - Método: ${metodoDB} - Recibido: S/${recibido} - Vuelto: S/${vuelto}`);
        res.json({ exito: true, numero_correlativo: correlativo, id_comprobante: resultComp.insertId });

    } catch (err) {
        if (connection) { try { await connection.rollback(); } catch {} }
        const status = err.httpStatus || 500;
        if (status === 500) console.error('❌ Error procesando pago:', err);
        res.status(status).json({ exito: false, mensaje: err.httpStatus ? err.message : 'Error interno al procesar el pago' });
    } finally {
        if (connection) connection.release();
    }
});

// ==========================================
// G. SEDES (Fase 2 · multi-sede)
// ==========================================
// Listado disponible para cualquier usuario autenticado (el panel admin lo
// usa para el selector global; incluye inactivas para mostrarlas en su tabla).
app.get('/api/sedes', (req, res) => {
    db.query('SELECT id_sede, codigo_sede, nombre, direccion, is_active FROM Sede ORDER BY id_sede', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/admin/sedes', (req, res) => {
    const { codigo_sede, nombre, direccion } = req.body;
    if (!codigo_sede || !nombre) return res.status(400).json({ exito: false, mensaje: 'El código y el nombre son obligatorios.' });
    if (!/^[A-Z]{2,5}$/.test(codigo_sede)) return res.status(400).json({ exito: false, mensaje: 'El código debe tener de 2 a 5 letras mayúsculas.' });

    db.query('INSERT INTO Sede (codigo_sede, nombre, direccion) VALUES (?, ?, ?)', [codigo_sede, nombre, direccion || null], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ exito: false, mensaje: 'Ya existe una sede con ese código.' });
            return res.status(500).json({ exito: false, mensaje: err.message });
        }
        registrarAuditoria(req.usuario.id_usuario, 'AÑADIR', 'Sede', `Sede creada: ${codigo_sede} - ${nombre}`);
        res.json({ exito: true, id_sede: result.insertId });
    });
});

app.put('/api/admin/sedes/:id', (req, res) => {
    const { codigo_sede, nombre, direccion } = req.body;
    if (!codigo_sede || !nombre) return res.status(400).json({ exito: false, mensaje: 'El código y el nombre son obligatorios.' });
    if (!/^[A-Z]{2,5}$/.test(codigo_sede)) return res.status(400).json({ exito: false, mensaje: 'El código debe tener de 2 a 5 letras mayúsculas.' });

    db.query('UPDATE Sede SET codigo_sede=?, nombre=?, direccion=?, is_active=1 WHERE id_sede=?', [codigo_sede, nombre, direccion || null, req.params.id], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ exito: false, mensaje: 'Ya existe otra sede con ese código.' });
            return res.status(500).json({ exito: false, mensaje: err.message });
        }
        if (result.affectedRows === 0) return res.status(404).json({ exito: false, mensaje: 'Sede no encontrada' });
        registrarAuditoria(req.usuario.id_usuario, 'MODIFICAR', 'Sede', `Sede actualizada: id ${req.params.id} - ${codigo_sede} ${nombre}`);
        res.json({ exito: true });
    });
});

app.put('/api/admin/sedes/:id/desactivar', (req, res) => {
    db.query('SELECT COUNT(*) n FROM Sede WHERE is_active = 1 AND id_sede <> ?', [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ exito: false, mensaje: err.message });
        if (rows[0].n === 0) return res.status(400).json({ exito: false, mensaje: 'No puedes desactivar la única sede activa.' });

        db.query('UPDATE Sede SET is_active = 0 WHERE id_sede = ?', [req.params.id], (err) => {
            if (err) return res.status(500).json({ exito: false, mensaje: err.message });
            // Los empleados de la sede quedan sin sede asignada (deberán reasignarse)
            db.query('UPDATE Usuario SET id_sede = NULL WHERE id_sede = ?', [req.params.id], (err) => {
                if (err) return res.status(500).json({ exito: false, mensaje: err.message });
                registrarAuditoria(req.usuario.id_usuario, 'ELIMINAR', 'Sede', `Sede desactivada: id ${req.params.id} (usuarios liberados)`);
                res.json({ exito: true });
            });
        });
    });
});

// ==========================================
// H. GESTIÓN DE USUARIOS (Fase 4 · RN-06)
// ==========================================
app.get('/api/roles', (req, res) => {
    db.query('SELECT id_rol, nombre_rol FROM Rol ORDER BY id_rol', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/admin/usuarios', (req, res) => {
    const query = `
        SELECT u.id_usuario, u.username, u.nombre_completo, u.correo, u.is_active,
               u.id_rol, r.nombre_rol, u.id_sede, s.nombre AS nombre_sede
        FROM Usuario u
        JOIN Rol r ON u.id_rol = r.id_rol
        LEFT JOIN Sede s ON u.id_sede = s.id_sede
        ORDER BY u.id_usuario
    `;
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/admin/usuarios', async (req, res) => {
    try {
        const { username, nombre_completo, correo, id_rol, id_sede, password } = req.body;
        if (!username || !nombre_completo || !id_rol || !password) {
            return res.status(400).json({ exito: false, mensaje: 'Usuario, nombre, rol y contraseña son obligatorios.' });
        }
        const p = db.promise();
        const [[duplicado]] = await p.query('SELECT id_usuario FROM Usuario WHERE username = ?', [username]);
        if (duplicado) return res.status(400).json({ exito: false, mensaje: 'Ese nombre de usuario ya existe.' });

        const hash = await bcrypt.hash(password, 10);
        const [r] = await p.query(
            'INSERT INTO Usuario (username, nombre_completo, password_hash, correo, id_rol, id_sede, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)',
            [username, nombre_completo, hash, correo || null, id_rol, id_sede || null]
        );
        registrarAuditoria(req.usuario.id_usuario, 'AÑADIR', 'Usuario', `Usuario creado: ${username} (rol ${id_rol}, sede ${id_sede || 'global'})`);
        res.json({ exito: true, id_usuario: r.insertId });
    } catch (err) {
        console.error('Error creando usuario:', err);
        res.status(500).json({ exito: false, mensaje: 'Error al crear el usuario' });
    }
});

app.put('/api/admin/usuarios/:id', async (req, res) => {
    try {
        const { username, nombre_completo, correo, id_rol, id_sede, password } = req.body;
        if (!username || !nombre_completo || !id_rol) {
            return res.status(400).json({ exito: false, mensaje: 'Usuario, nombre y rol son obligatorios.' });
        }
        const p = db.promise();
        const [[duplicado]] = await p.query('SELECT id_usuario FROM Usuario WHERE username = ? AND id_usuario <> ?', [username, req.params.id]);
        if (duplicado) return res.status(400).json({ exito: false, mensaje: 'Ese nombre de usuario ya existe.' });

        await p.query(
            'UPDATE Usuario SET username=?, nombre_completo=?, correo=?, id_rol=?, id_sede=? WHERE id_usuario=?',
            [username, nombre_completo, correo || null, id_rol, id_sede || null, req.params.id]
        );
        if (password) {
            const hash = await bcrypt.hash(password, 10);
            await p.query('UPDATE Usuario SET password_hash=? WHERE id_usuario=?', [hash, req.params.id]);
        }
        registrarAuditoria(req.usuario.id_usuario, 'MODIFICAR', 'Usuario', `Usuario actualizado: id ${req.params.id} (${username})` + (password ? ' — contraseña restablecida' : ''));
        res.json({ exito: true });
    } catch (err) {
        console.error('Error actualizando usuario:', err);
        res.status(500).json({ exito: false, mensaje: 'Error al actualizar el usuario' });
    }
});

// Activar/desactivar (nunca DELETE físico). body: { activar: true|false }
app.put('/api/admin/usuarios/:id/desactivar', (req, res) => {
    const idObjetivo = parseInt(req.params.id);
    if (idObjetivo === req.usuario.id_usuario) {
        return res.status(400).json({ exito: false, mensaje: 'No puedes desactivar tu propia cuenta.' });
    }
    const activar = req.body && req.body.activar === true;
    db.query('UPDATE Usuario SET is_active = ? WHERE id_usuario = ?', [activar ? 1 : 0, idObjetivo], (err, result) => {
        if (err) return res.status(500).json({ exito: false, mensaje: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ exito: false, mensaje: 'Usuario no encontrado' });
        registrarAuditoria(req.usuario.id_usuario, activar ? 'MODIFICAR' : 'ELIMINAR', 'Usuario', `Usuario ${activar ? 'reactivado' : 'desactivado'}: id ${idObjetivo}`);
        res.json({ exito: true });
    });
});

// ==========================================
// I. GESTIÓN DE CATEGORÍAS (Fase 4)
// ==========================================
app.post('/api/categorias', (req, res) => {
    if (!esAdmin(req)) return res.status(403).json({ exito: false, mensaje: 'Acceso restringido a administradores.' });
    const { nombre, icono } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ exito: false, mensaje: 'El nombre es obligatorio.' });

    db.query('SELECT id_categoria FROM Categoria WHERE LOWER(nombre) = LOWER(?)', [nombre.trim()], (err, rows) => {
        if (err) return res.status(500).json({ exito: false, mensaje: err.message });
        if (rows.length > 0) return res.status(400).json({ exito: false, mensaje: 'Ya existe una categoría con ese nombre.' });

        db.query('INSERT INTO Categoria (nombre, icono, is_active) VALUES (?, ?, 1)', [nombre.trim(), icono || null], (err, result) => {
            if (err) return res.status(500).json({ exito: false, mensaje: err.message });
            registrarAuditoria(req.usuario.id_usuario, 'AÑADIR', 'Categoria', `Categoría creada: ${nombre.trim()}`);
            res.json({ exito: true, id_categoria: result.insertId });
        });
    });
});

app.put('/api/categorias/:id', (req, res) => {
    if (!esAdmin(req)) return res.status(403).json({ exito: false, mensaje: 'Acceso restringido a administradores.' });
    const { nombre, icono } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ exito: false, mensaje: 'El nombre es obligatorio.' });

    db.query('SELECT id_categoria FROM Categoria WHERE LOWER(nombre) = LOWER(?) AND id_categoria <> ?', [nombre.trim(), req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ exito: false, mensaje: err.message });
        if (rows.length > 0) return res.status(400).json({ exito: false, mensaje: 'Ya existe otra categoría con ese nombre.' });

        db.query('UPDATE Categoria SET nombre=?, icono=?, is_active=1 WHERE id_categoria=?', [nombre.trim(), icono || null, req.params.id], (err, result) => {
            if (err) return res.status(500).json({ exito: false, mensaje: err.message });
            if (result.affectedRows === 0) return res.status(404).json({ exito: false, mensaje: 'Categoría no encontrada' });
            registrarAuditoria(req.usuario.id_usuario, 'MODIFICAR', 'Categoria', `Categoría actualizada: id ${req.params.id} - ${nombre.trim()}`);
            res.json({ exito: true });
        });
    });
});

app.put('/api/categorias/:id/desactivar', (req, res) => {
    if (!esAdmin(req)) return res.status(403).json({ exito: false, mensaje: 'Acceso restringido a administradores.' });

    db.query('SELECT COUNT(*) n FROM Producto WHERE id_categoria = ? AND is_active = 1', [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ exito: false, mensaje: err.message });
        if (rows[0].n > 0) {
            return res.status(400).json({ exito: false, mensaje: `La categoría tiene ${rows[0].n} producto(s) activo(s). Reasícalos o desactívalos primero.` });
        }
        db.query('UPDATE Categoria SET is_active = 0 WHERE id_categoria = ?', [req.params.id], (err) => {
            if (err) return res.status(500).json({ exito: false, mensaje: err.message });
            registrarAuditoria(req.usuario.id_usuario, 'ELIMINAR', 'Categoria', `Categoría desactivada: id ${req.params.id}`);
            res.json({ exito: true });
        });
    });
});

// ==========================================
// J. REPORTES DE VENTAS (Fase 4 · RN-08)
// Solo pedidos COMPLETADOS. ?agrupacion=dia|semana|mes&desde&hasta&sede
// ==========================================
app.get('/api/admin/reportes/ventas', (req, res) => {
    const { agrupacion = 'dia', desde, hasta, sede } = req.query;
    const agrupacionesValidas = ['dia', 'semana', 'mes'];
    const hoy = fechaHoyISOPeru();

    if (!agrupacionesValidas.includes(agrupacion)) {
        return res.status(400).json({ exito: false, mensaje: 'Agrupacion de reporte no valida.' });
    }
    if ((desde && !fechaISOValida(desde)) || (hasta && !fechaISOValida(hasta))) {
        return res.status(400).json({ exito: false, mensaje: 'Formato de fecha no valido. Usa AAAA-MM-DD.' });
    }
    if ((desde && desde < FECHA_MIN_SISTEMA) || (hasta && hasta < FECHA_MIN_SISTEMA)) {
        return res.status(400).json({ exito: false, mensaje: `El reporte no puede consultar fechas anteriores a ${FECHA_MIN_SISTEMA}.` });
    }
    if ((desde && desde > hoy) || (hasta && hasta > hoy)) {
        return res.status(400).json({ exito: false, mensaje: 'El reporte no puede consultar fechas posteriores al dia actual.' });
    }
    if (desde && hasta && desde > hasta) {
        return res.status(400).json({ exito: false, mensaje: 'La fecha Desde no puede ser posterior a la fecha Hasta.' });
    }

    let periodoExpr;
    if (agrupacion === 'semana') {
        // Semana ISO: "2026-S29"
        periodoExpr = "CONCAT(YEAR(p.fecha_pedido), '-S', LPAD(WEEK(p.fecha_pedido, 3), 2, '0'))";
    } else if (agrupacion === 'mes') {
        periodoExpr = "DATE_FORMAT(p.fecha_pedido, '%Y-%m')";
    } else {
        periodoExpr = "DATE_FORMAT(p.fecha_pedido, '%Y-%m-%d')";
    }

    const desdeConsulta = desde || FECHA_MIN_SISTEMA;
    const hastaConsulta = hasta || hoy;
    const conSede = sede !== undefined && sede !== '';
    const idSede = conSede ? parseInt(sede, 10) : null;
    if (conSede && !Number.isInteger(idSede)) {
        return res.status(400).json({ exito: false, mensaje: 'Sede de reporte no valida.' });
    }
    // Con filtro de sede mostramos su nombre; sin filtro la fila agrega todas
    const selectSede = conSede ? 'MAX(s.nombre) AS nombre_sede' : 'NULL AS nombre_sede';

    let query = `
        SELECT ${periodoExpr} AS periodo,
               ${selectSede},
               COUNT(*) AS num_pedidos,
               SUM(p.total) AS total_vendido
        FROM Pedido p
        LEFT JOIN Sede s ON p.id_sede = s.id_sede
        WHERE p.estado = 'Completado'
    `;
    const params = [];
    query += ' AND DATE(p.fecha_pedido) >= ?';
    params.push(desdeConsulta);
    query += ' AND DATE(p.fecha_pedido) <= ?';
    params.push(hastaConsulta);
    if (conSede) { query += ' AND p.id_sede = ?'; params.push(idSede); }
    query += ' GROUP BY periodo ORDER BY periodo';

    db.query(query, params, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
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

        // En lugar de enviar el correo desde Render (bloqueado), 
        // le pedimos a Vercel que lo envíe por nosotros (desbloqueado)
        try {
            const vercelRes = await fetch('https://bookcenter-sistema.vercel.app/api/enviar-correo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    correo: correo,
                    codigo: codigo,
                    nombre_completo: usuario.nombre_completo
                })
            });

            const vercelData = await vercelRes.json();

            if (vercelData.exito) {
                res.json({ exito: true, mensaje: 'Código enviado al correo (vía Vercel).' });
            } else {
                console.error('❌ Error desde Vercel:', vercelData.detalle);
                res.status(500).json({ exito: false, mensaje: 'Error interno SMTP (Vercel): ' + vercelData.detalle });
            }
        } catch (fetchErr) {
            console.error('❌ Error contactando a Vercel:', fetchErr);
            res.status(500).json({ exito: false, mensaje: 'Error de comunicación con Vercel: ' + fetchErr.message });
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
