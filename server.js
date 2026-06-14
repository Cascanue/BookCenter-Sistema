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
const db = mysql.createConnection({
    host: 'mysql-955eb71-bookcenter27.b.aivencloud.com',
    user: 'avnadmin',
    password: process.env.AIVEN_PASSWORD,
    port: 22639,
    database: 'defaultdb',
    ssl: { rejectUnauthorized: false }
});

db.connect(err => {
    if (err) console.error('❌ Error en MySQL:', err);
    else console.log('✅ Conectado a Aiven MySQL con éxito.');
});

// ==========================================
// C. RUTAS DEL SISTEMA (Endpoints)
// ==========================================

// 1. RUTA DE LOGIN (Verifica credenciales y rol)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    // Buscamos al usuario y traemos el nombre de su rol
    const query = `
        SELECT u.id_usuario, u.username, r.nombre_rol 
        FROM Usuario u 
        INNER JOIN Rol r ON u.id_rol = r.id_rol 
        WHERE u.username = ? AND u.password_hash = ? AND u.is_active = TRUE
    `;
    
    db.query(query, [username, password], (err, results) => {
        if (err) {
            console.error('Error en Login:', err);
            return res.status(500).json({ exito: false, mensaje: 'Error del servidor' });
        }
        
        if (results.length > 0) {
            // Usuario encontrado
            res.status(200).json({ exito: true, usuario: results[0] });
        } else {
            // Credenciales incorrectas
            res.status(401).json({ exito: false, mensaje: 'Usuario o contraseña incorrectos' });
        }
    });
});

// 2. RUTA REGISTRAR CLIENTE (Con Auditoría Básica)
app.post('/api/registrar-cliente', (req, res) => {
    const { tipoDoc, numDoc, nombreCompleto, telefono, correo, idCreador } = req.body;
    
    const query = `
        INSERT INTO Cliente (tipo_documento, numero_documento, nombre_razon_social, telefono, correo, created_by) 
        VALUES (?, ?, ?, ?, ?, ?)
    `;
    
    db.query(query, [tipoDoc, numDoc, nombreCompleto, telefono, correo, idCreador], (err, results) => {
        if (err) {
            console.error('Error guardando cliente:', err);
            // Validar si el DNI/RUC ya existe (numero_documento es UNIQUE en la BD)
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ exito: false, mensaje: 'Este documento ya está registrado en el sistema.' });
            }
            return res.status(500).json({ exito: false, mensaje: 'Error interno al guardar en la base de datos' });
        }
        res.status(200).json({ exito: true, mensaje: 'Cliente registrado exitosamente' });
    });
});

// ==========================================
// D. RUTAS EN PAUSA (Módulo de Productos)
// ==========================================
/* Nota: Estas rutas están comentadas para que no den error con la nueva 
    tabla de la base de datos. Las activaremos y actualizaremos cuando 
    hagamos el Módulo de Inventario.

app.post('/api/registrar-producto', upload.single('imagenProducto'), (req, res) => { ... });
app.get('/api/productos', (req, res) => { ... });
*/

// ==========================================
// E. ENCENDIDO DEL SERVIDOR
// ==========================================
// Le decimos a Node que use el puerto que Render le dé, o el 3000 si estás en tu PC
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor de Book Center corriendo en el puerto ${PORT}`));