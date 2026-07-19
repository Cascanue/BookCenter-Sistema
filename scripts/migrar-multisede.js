// ============================================================
// RUNNER DE MIGRACIÓN MULTI-SEDE — Book Center
// Ejecutar con:  node scripts/migrar-multisede.js
//
// Aplica los pasos de migracion_multisede.sql de forma IDEMPOTENTE:
// cada paso verifica en information_schema si ya fue aplicado, así
// que es seguro ejecutarlo varias veces.
//
// Requiere en .env: AIVEN_HOST, AIVEN_USER, AIVEN_PASSWORD
// (y opcionalmente AIVEN_PORT, AIVEN_DATABASE).
// ============================================================
require('dotenv').config();
const mysql = require('mysql2/promise');

const DB_NAME = process.env.AIVEN_DATABASE || 'defaultdb';

async function main() {
    if (!process.env.AIVEN_HOST || !process.env.AIVEN_USER) {
        console.error('❌ Faltan AIVEN_HOST y/o AIVEN_USER en el .env. Agrégalos (los mismos valores configurados en Render) y vuelve a ejecutar.');
        process.exit(1);
    }

    const con = await mysql.createConnection({
        host: process.env.AIVEN_HOST,
        user: process.env.AIVEN_USER,
        password: process.env.AIVEN_PASSWORD,
        port: process.env.AIVEN_PORT || 22639,
        database: DB_NAME,
        ssl: { rejectUnauthorized: false },
        multipleStatements: false
    });
    console.log(`✅ Conectado a ${process.env.AIVEN_HOST}/${DB_NAME}`);

    const tablaExiste = async (tabla) => {
        const [rows] = await con.query(
            'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
            [DB_NAME, tabla]
        );
        return rows[0].n > 0;
    };
    const columnaExiste = async (tabla, columna) => {
        const [rows] = await con.query(
            'SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
            [DB_NAME, tabla, columna]
        );
        return rows[0].n > 0;
    };
    const paso = (msg) => console.log('  → ' + msg);

    // ---------- 1. Tabla Sede ----------
    console.log('\n[1] Tabla Sede');
    await con.query(`CREATE TABLE IF NOT EXISTS Sede (
        id_sede INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        codigo_sede VARCHAR(5) NOT NULL UNIQUE,
        nombre VARCHAR(100) NOT NULL,
        direccion VARCHAR(255) NULL,
        is_active TINYINT(1) DEFAULT 1
    )`);
    const [[{ nSedes }]] = await con.query('SELECT COUNT(*) nSedes FROM Sede');
    if (nSedes === 0) {
        await con.query(`INSERT INTO Sede (codigo_sede, nombre, direccion) VALUES ('AY', 'Sede Ayacucho', 'Ayacucho — local original')`);
        await con.query(`INSERT INTO Sede (codigo_sede, nombre, direccion) VALUES ('VH', 'Sede Vista Hermosa', 'Sede Vista Hermosa')`);
        paso('Sedes iniciales "AY — Sede Ayacucho" (id 1) y "VH — Sede Vista Hermosa" (id 2) creadas.');
    } else {
        paso(`Ya existen ${nSedes} sede(s), no se insertó ninguna.`);
    }

    // ---------- 2. Tabla Inventario_Sede ----------
    console.log('\n[2] Tabla Inventario_Sede');
    await con.query(`CREATE TABLE IF NOT EXISTS Inventario_Sede (
        id_inventario INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        id_producto INT NOT NULL,
        id_sede INT NOT NULL,
        stock_actual INT NOT NULL DEFAULT 0,
        stock_minimo INT NOT NULL DEFAULT 5,
        UNIQUE KEY uq_producto_sede (id_producto, id_sede),
        CONSTRAINT fk_inv_producto FOREIGN KEY (id_producto) REFERENCES Producto (id_producto),
        CONSTRAINT fk_inv_sede FOREIGN KEY (id_sede) REFERENCES Sede (id_sede)
    )`);
    paso('OK');

    // ---------- 3. Migrar stock de Producto → Inventario_Sede (sede 1) ----------
    console.log('\n[3] Migración de stock del catálogo');
    if (await columnaExiste('Producto', 'stock_actual')) {
        const [r] = await con.query(`
            INSERT IGNORE INTO Inventario_Sede (id_producto, id_sede, stock_actual, stock_minimo)
            SELECT id_producto, 1, stock_actual, COALESCE(stock_minimo, 5) FROM Producto
        `);
        paso(`Copiadas ${r.affectedRows} fila(s) de stock a la sede 1.`);
        await con.query('ALTER TABLE Producto DROP COLUMN stock_actual');
        if (await columnaExiste('Producto', 'stock_minimo')) {
            await con.query('ALTER TABLE Producto DROP COLUMN stock_minimo');
        }
        paso('Columnas stock_actual/stock_minimo eliminadas de Producto.');
    } else {
        paso('Producto ya no tiene columnas de stock — paso omitido.');
    }

    // ---------- 4. Usuario.id_sede ----------
    console.log('\n[4] Usuario.id_sede');
    if (!(await columnaExiste('Usuario', 'id_sede'))) {
        await con.query('ALTER TABLE Usuario ADD COLUMN id_sede INT NULL');
        await con.query('ALTER TABLE Usuario ADD CONSTRAINT fk_usuario_sede FOREIGN KEY (id_sede) REFERENCES Sede (id_sede)');
        const [r] = await con.query(`
            UPDATE Usuario u JOIN Rol r ON u.id_rol = r.id_rol
            SET u.id_sede = CASE WHEN LOWER(r.nombre_rol) = 'administrador' THEN NULL ELSE 1 END
        `);
        paso(`Columna creada; ${r.affectedRows} usuario(s) asignados (admins → global, resto → sede 1).`);
    } else {
        paso('Ya existía — paso omitido.');
    }

    // ---------- 5. Pedido.id_sede + motivo_anulacion ----------
    console.log('\n[5] Pedido.id_sede y motivo_anulacion');
    if (!(await columnaExiste('Pedido', 'id_sede'))) {
        await con.query('ALTER TABLE Pedido ADD COLUMN id_sede INT NULL');
        await con.query('ALTER TABLE Pedido ADD CONSTRAINT fk_pedido_sede FOREIGN KEY (id_sede) REFERENCES Sede (id_sede)');
        const [r] = await con.query('UPDATE Pedido SET id_sede = 1 WHERE id_sede IS NULL');
        paso(`Columna creada; ${r.affectedRows} pedido(s) históricos asignados a la sede 1.`);
    } else {
        paso('id_sede ya existía — paso omitido.');
    }
    if (!(await columnaExiste('Pedido', 'motivo_anulacion'))) {
        await con.query('ALTER TABLE Pedido ADD COLUMN motivo_anulacion VARCHAR(255) NULL');
        paso('motivo_anulacion agregado a Pedido.');
    } else {
        paso('motivo_anulacion ya existía.');
    }

    // ---------- 6. Comprobante_Pago: id_sede + columnas de anulación ----------
    console.log('\n[6] Comprobante_Pago');
    if (!(await columnaExiste('Comprobante_Pago', 'id_sede'))) {
        await con.query('ALTER TABLE Comprobante_Pago ADD COLUMN id_sede INT NULL');
        await con.query('ALTER TABLE Comprobante_Pago ADD CONSTRAINT fk_comprobante_sede FOREIGN KEY (id_sede) REFERENCES Sede (id_sede)');
        await con.query('UPDATE Comprobante_Pago SET id_sede = 1 WHERE id_sede IS NULL');
        paso('id_sede agregado y backfill a sede 1.');
    } else {
        paso('id_sede ya existía.');
    }
    if (!(await columnaExiste('Comprobante_Pago', 'motivo_anulacion'))) {
        await con.query('ALTER TABLE Comprobante_Pago ADD COLUMN motivo_anulacion VARCHAR(255) NULL');
        paso('motivo_anulacion agregado.');
    } else paso('motivo_anulacion ya existía.');
    if (!(await columnaExiste('Comprobante_Pago', 'estado_comprobante'))) {
        await con.query(`ALTER TABLE Comprobante_Pago ADD COLUMN estado_comprobante ENUM('Vigente','Anulado') NOT NULL DEFAULT 'Vigente'`);
        paso('estado_comprobante agregado.');
    } else paso('estado_comprobante ya existía.');

    // ---------- 7. Pago: vuelto y fecha_pago ----------
    console.log('\n[7] Pago (vuelto, fecha_pago)');
    if (!(await columnaExiste('Pago', 'vuelto'))) {
        await con.query('ALTER TABLE Pago ADD COLUMN vuelto DECIMAL(10,2) NULL');
        paso('vuelto agregado.');
    } else paso('vuelto ya existía.');
    if (!(await columnaExiste('Pago', 'fecha_pago'))) {
        await con.query('ALTER TABLE Pago ADD COLUMN fecha_pago DATETIME NULL DEFAULT CURRENT_TIMESTAMP');
        paso('fecha_pago agregado.');
    } else paso('fecha_pago ya existía.');

    // ---------- 8. Correlativo_Sede ----------
    console.log('\n[8] Tabla Correlativo_Sede');
    await con.query(`CREATE TABLE IF NOT EXISTS Correlativo_Sede (
        id_sede INT NOT NULL,
        tipo_comprobante VARCHAR(20) NOT NULL,
        ultimo_numero INT NOT NULL DEFAULT 0,
        PRIMARY KEY (id_sede, tipo_comprobante),
        CONSTRAINT fk_correlativo_sede FOREIGN KEY (id_sede) REFERENCES Sede (id_sede)
    )`);
    paso('OK (los contadores se crean bajo demanda al emitir comprobantes).');

    // ---------- 9. Usuario.nombre_completo (la creaba el server al arrancar) ----------
    console.log('\n[9] Usuario.nombre_completo');
    if (!(await columnaExiste('Usuario', 'nombre_completo'))) {
        await con.query(`ALTER TABLE Usuario ADD COLUMN nombre_completo VARCHAR(150) NOT NULL DEFAULT 'Usuario del Sistema'`);
        paso('Columna creada.');
    } else paso('Ya existía.');

    // ---------- Resumen final ----------
    console.log('\n============ RESUMEN ============');
    for (const t of ['Sede', 'Inventario_Sede', 'Correlativo_Sede']) {
        const [[{ n }]] = await con.query(`SELECT COUNT(*) n FROM ${t}`);
        console.log(`  ${t}: ${n} fila(s)`);
    }
    console.log('\n🌟 Migración completada. Recuerda desplegar el nuevo server.js AHORA (el antiguo dejó de ser compatible).');
    await con.end();
}

main().catch(err => {
    console.error('\n❌ Error en la migración:', err.message);
    console.error('La migración es idempotente: corrige el problema y vuelve a ejecutarla.');
    process.exit(1);
});
