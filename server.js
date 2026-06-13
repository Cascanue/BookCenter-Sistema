require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

// A. Configuración de Cloudinary (Toma las llaves del .env)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// B. Configuración de Multer (Memoria temporal para recibir la foto)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// C. Conexión a Aiven MySQL
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


// D. RUTA 1: Recibir formulario, subir a Cloudinary y guardar en MySQL
app.post('/api/registrar-producto', upload.single('imagenProducto'), (req, res) => {
    const { nombre, precio, stock } = req.body;
    
    if (!req.file) {
        return res.status(400).json({ mensaje: 'Falta subir la imagen del producto' });
    }

    // 1. Subir el archivo binario directamente a la nube de Cloudinary
    cloudinary.uploader.upload_stream({ folder: 'bookcenter_productos' }, (error, resultadoCloudinary) => {
        if (error) {
            console.error('Error en Cloudinary:', error);
            return res.status(500).json({ mensaje: 'Error al subir la imagen a la nube' });
        }

        // 2. Cloudinary nos regala el link limpio de la foto
        const linkFoto = resultadoCloudinary.secure_url;

        // 3. Guardamos los textos y ese link en tu MySQL de Aiven
        const query = 'INSERT INTO Producto (nombre, precio, stock, url_imagen) VALUES (?, ?, ?, ?)';
        db.query(query, [nombre, precio, stock, linkFoto], (err, results) => {
            if (err) {
                console.error('Error en SQL:', err);
                return res.status(500).json({ mensaje: 'Error al guardar en la base de datos' });
            }
            res.status(200).json({ mensaje: '¡Producto y foto guardados exitosamente!' });
        });
    }).end(req.file.buffer);
});

// E. RUTA 2: Traer todos los productos guardados para mostrarlos abajo
app.get('/api/productos', (req, res) => {
    db.query('SELECT * FROM Producto', (err, filas) => {
        if (err) return res.status(500).json({ error: err.message });
        res.status(200).json(filas);
    });
});

app.listen(3000, () => console.log('🚀 Servidor de Book Center corriendo en el puerto 3000'));