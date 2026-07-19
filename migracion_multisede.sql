-- ============================================================
-- MIGRACIÓN MULTI-SEDE — Book Center (Fase 1 · Persona A)
-- ============================================================
-- Este archivo documenta la migración. La ejecución real se hace
-- con `node scripts/migrar-multisede.js`, que aplica estos mismos
-- pasos de forma IDEMPOTENTE (verifica information_schema antes
-- de cada ALTER, porque MySQL 8 no soporta ADD COLUMN IF NOT EXISTS).
--
-- ⚠️ IMPORTANTE: ejecutar la migración y desplegar el nuevo server.js
-- EN EL MISMO MOMENTO. El server.js antiguo lee Producto.stock_actual,
-- columna que esta migración elimina.
-- ============================================================

-- 1. Tabla de sedes
CREATE TABLE IF NOT EXISTS Sede (
    id_sede     INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    codigo_sede VARCHAR(5)  NOT NULL UNIQUE,
    nombre      VARCHAR(100) NOT NULL,
    direccion   VARCHAR(255) NULL,
    is_active   TINYINT(1) DEFAULT 1
);

-- Sede inicial (todo el histórico pertenece a ella)
INSERT INTO Sede (codigo_sede, nombre, direccion)
SELECT 'AY', 'Sede Ayacucho', 'Ayacucho — local original'
WHERE NOT EXISTS (SELECT 1 FROM Sede);

-- Segunda sede (Sede Vista Hermosa)
INSERT INTO Sede (codigo_sede, nombre, direccion)
SELECT 'VH', 'Sede Vista Hermosa', 'Sede Vista Hermosa'
WHERE NOT EXISTS (SELECT 1 FROM Sede WHERE codigo_sede = 'VH');

-- 2. Inventario separado del catálogo ("Camino B")
CREATE TABLE IF NOT EXISTS Inventario_Sede (
    id_inventario INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    id_producto   INT NOT NULL,
    id_sede       INT NOT NULL,
    stock_actual  INT NOT NULL DEFAULT 0,
    stock_minimo  INT NOT NULL DEFAULT 5,
    UNIQUE KEY uq_producto_sede (id_producto, id_sede),
    CONSTRAINT fk_inv_producto FOREIGN KEY (id_producto) REFERENCES Producto (id_producto),
    CONSTRAINT fk_inv_sede     FOREIGN KEY (id_sede)     REFERENCES Sede (id_sede)
);

-- 3. Copiar el stock actual a la sede 1 y ELIMINAR las columnas de Producto
--    (el runner solo lo hace si Producto.stock_actual todavía existe)
INSERT INTO Inventario_Sede (id_producto, id_sede, stock_actual, stock_minimo)
SELECT id_producto, 1, stock_actual, COALESCE(stock_minimo, 5) FROM Producto;

ALTER TABLE Producto DROP COLUMN stock_actual;
ALTER TABLE Producto DROP COLUMN stock_minimo;

-- 4. Sede en Usuario (NULL = administrador global)
ALTER TABLE Usuario ADD COLUMN id_sede INT NULL;
ALTER TABLE Usuario ADD CONSTRAINT fk_usuario_sede FOREIGN KEY (id_sede) REFERENCES Sede (id_sede);
UPDATE Usuario u JOIN Rol r ON u.id_rol = r.id_rol
SET u.id_sede = CASE WHEN LOWER(r.nombre_rol) = 'administrador' THEN NULL ELSE 1 END;

-- 5. Sede en Pedido
ALTER TABLE Pedido ADD COLUMN id_sede INT NULL;
ALTER TABLE Pedido ADD CONSTRAINT fk_pedido_sede FOREIGN KEY (id_sede) REFERENCES Sede (id_sede);
UPDATE Pedido SET id_sede = 1 WHERE id_sede IS NULL;

-- Motivo de anulación de pedidos (Fase 3.4)
ALTER TABLE Pedido ADD COLUMN motivo_anulacion VARCHAR(255) NULL;

-- 6. Sede en Comprobante_Pago
ALTER TABLE Comprobante_Pago ADD COLUMN id_sede INT NULL;
ALTER TABLE Comprobante_Pago ADD CONSTRAINT fk_comprobante_sede FOREIGN KEY (id_sede) REFERENCES Sede (id_sede);
UPDATE Comprobante_Pago SET id_sede = 1 WHERE id_sede IS NULL;

-- Columnas de anulación (antes se creaban en el arranque del server; ahora viven aquí)
ALTER TABLE Comprobante_Pago ADD COLUMN motivo_anulacion VARCHAR(255) NULL;
ALTER TABLE Comprobante_Pago ADD COLUMN estado_comprobante ENUM('Vigente','Anulado') NOT NULL DEFAULT 'Vigente';

-- 7. Pago fiel (Fase 3.3): vuelto y fecha real del pago
ALTER TABLE Pago ADD COLUMN vuelto DECIMAL(10,2) NULL;
ALTER TABLE Pago ADD COLUMN fecha_pago DATETIME NULL DEFAULT CURRENT_TIMESTAMP;

-- 8. Numeración correlativa segura por sede y tipo (Fase 3.2)
CREATE TABLE IF NOT EXISTS Correlativo_Sede (
    id_sede          INT NOT NULL,
    tipo_comprobante VARCHAR(20) NOT NULL,
    ultimo_numero    INT NOT NULL DEFAULT 0,
    PRIMARY KEY (id_sede, tipo_comprobante),
    CONSTRAINT fk_correlativo_sede FOREIGN KEY (id_sede) REFERENCES Sede (id_sede)
);
-- Los contadores se crean bajo demanda (INSERT IGNORE) al emitir el primer
-- comprobante de cada sede/tipo. El formato nuevo del número es
-- "<CODIGO_SEDE>-00000001", por lo que no colisiona con los históricos.

-- 9. Garantizar columnas que el server antiguo creaba al arrancar
ALTER TABLE Usuario ADD COLUMN nombre_completo VARCHAR(150) NOT NULL DEFAULT 'Usuario del Sistema';
