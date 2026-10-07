'use strict';
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_CONFIG = {
    host: (process.env.DB_NAME === 'doct_futbolsanantonio' ? process.env.DB_HOST : null) || 'mysql-doct.alwaysdata.net',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: (process.env.DB_NAME === 'doct_futbolsanantonio' ? process.env.DB_USER : null) || 'doct',
    password: (process.env.DB_NAME === 'doct_futbolsanantonio' ? process.env.DB_PASSWORD : null) || 'i65zWEc7S9mg#34',
    database: 'doct_futbolsanantonio',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool = null;
let isConnected = false;

async function initDB() {
    try {
        pool = mysql.createPool(DB_CONFIG);

        try {
            await pool.query('SELECT 1');
        } catch (dbErr) {
            if (dbErr.code === 'ER_BAD_DB_ERROR') {
                const initConn = await mysql.createConnection({
                    host: DB_CONFIG.host,
                    port: DB_CONFIG.port,
                    user: DB_CONFIG.user,
                    password: DB_CONFIG.password
                });
                await initConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
                await initConn.end();
            } else {
                throw dbErr;
            }
        }

        // Crear tablas
        await pool.query(`
            CREATE TABLE IF NOT EXISTS equipos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nombre VARCHAR(150) NOT NULL UNIQUE,
                habilitado_impresion TINYINT(1) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS jugadores (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nombre VARCHAR(150) NOT NULL,
                equipo VARCHAR(150) NOT NULL,
                filename VARCHAR(255) NOT NULL UNIQUE,
                impreso TINYINT(1) DEFAULT 0,
                aprobado TINYINT(1) DEFAULT 1,
                foto_blob LONGBLOB NULL,
                qr_token VARCHAR(64) NULL UNIQUE,
                fecha_impresion DATETIME NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_equipo (equipo),
                INDEX idx_nombre (nombre),
                INDEX idx_aprobado (aprobado)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        isConnected = true;
        console.log(`[MySQL] Conexión establecida con éxito en la base de datos '${DB_CONFIG.database}'.`);
        return true;
    } catch (err) {
        isConnected = false;
        console.error('[MySQL] Error al inicializar base de datos:', err.message);
        return false;
    }
}

function getStatus() {
    return {
        connected: isConnected,
        database: DB_CONFIG.database,
        user: DB_CONFIG.user,
        host: DB_CONFIG.host
    };
}

async function getEquipos() {
    if (!isConnected || !pool) return [];
    try {
        const [rows] = await pool.query('SELECT * FROM equipos ORDER BY nombre ASC');
        return rows;
    } catch (err) {
        console.error('[MySQL] Error getEquipos:', err.message);
        return [];
    }
}

async function setEquipoHabilitado(nombre, habilitado) {
    if (!isConnected || !pool) return false;
    try {
        await pool.query(`
            INSERT INTO equipos (nombre, habilitado_impresion)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE habilitado_impresion = VALUES(habilitado_impresion)
        `, [nombre, habilitado ? 1 : 0]);
        return true;
    } catch (err) {
        console.error('[MySQL] Error setEquipoHabilitado:', err.message);
        return false;
    }
}

async function setTodosEquiposHabilitados(habilitado) {
    if (!isConnected || !pool) return false;
    try {
        await pool.query('UPDATE equipos SET habilitado_impresion = ?', [habilitado ? 1 : 0]);
        return true;
    } catch (err) {
        console.error('[MySQL] Error setTodosEquiposHabilitados:', err.message);
        return false;
    }
}

async function crearEquipo(nombre, habilitado = 1) {
    if (!isConnected || !pool) throw new Error('No hay conexión con la base de datos MySQL.');
    try {
        const nomLimpio = nombre.trim();
        const [existente] = await pool.query(
            'SELECT id, nombre FROM equipos WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
            [nomLimpio]
        );
        if (existente.length > 0) {
            const err = new Error(`El equipo "${nomLimpio}" ya existe.`);
            err.code = 'EQUIPO_DUPLICADO';
            throw err;
        }
        const [result] = await pool.query(
            'INSERT INTO equipos (nombre, habilitado_impresion) VALUES (?, ?)',
            [nomLimpio, habilitado ? 1 : 0]
        );
        return {
            id: result.insertId,
            nombre: nomLimpio,
            habilitado: habilitado ? 1 : 0
        };
    } catch (err) {
        console.error('[MySQL] Error crearEquipo:', err.message);
        throw err;
    }
}

async function actualizarEquipo(oldNombre, nuevoNombre, habilitado) {
    if (!isConnected || !pool) throw new Error('No hay conexión con la base de datos MySQL.');
    try {
        const nomActual = oldNombre.trim();
        const nomNuevo = (nuevoNombre || oldNombre).trim();

        if (nomNuevo.toLowerCase() !== nomActual.toLowerCase()) {
            const [existente] = await pool.query(
                'SELECT id FROM equipos WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?)) AND LOWER(TRIM(nombre)) != LOWER(TRIM(?))',
                [nomNuevo, nomActual]
            );
            if (existente.length > 0) {
                const err = new Error(`Ya existe otro equipo con el nombre "${nomNuevo}".`);
                err.code = 'EQUIPO_DUPLICADO';
                throw err;
            }
        }

        // Actualizar tabla equipos
        if (habilitado !== undefined && habilitado !== null) {
            await pool.query(
                'UPDATE equipos SET nombre = ?, habilitado_impresion = ? WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
                [nomNuevo, habilitado ? 1 : 0, nomActual]
            );
        } else {
            await pool.query(
                'UPDATE equipos SET nombre = ? WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
                [nomNuevo, nomActual]
            );
        }

        // Si cambió el nombre, actualizar en jugadores
        if (nomNuevo.toLowerCase() !== nomActual.toLowerCase()) {
            await pool.query(
                'UPDATE jugadores SET equipo = ? WHERE LOWER(TRIM(equipo)) = LOWER(TRIM(?))',
                [nomNuevo, nomActual]
            );
        }

        return true;
    } catch (err) {
        console.error('[MySQL] Error actualizarEquipo:', err.message);
        throw err;
    }
}

async function eliminarEquipo(nombre, eliminarJugadores = false) {
    if (!isConnected || !pool) throw new Error('No hay conexión con la base de datos MySQL.');
    try {
        const nom = nombre.trim();
        const [jugadores] = await pool.query(
            'SELECT id, filename FROM jugadores WHERE LOWER(TRIM(equipo)) = LOWER(TRIM(?))',
            [nom]
        );

        if (jugadores.length > 0 && !eliminarJugadores) {
            const err = new Error(`El equipo tiene ${jugadores.length} jugador(es) asociado(s).`);
            err.code = 'EQUIPO_CON_JUGADORES';
            err.totalJugadores = jugadores.length;
            throw err;
        }

        if (jugadores.length > 0 && eliminarJugadores) {
            await pool.query('DELETE FROM jugadores WHERE LOWER(TRIM(equipo)) = LOWER(TRIM(?))', [nom]);
        }

        await pool.query('DELETE FROM equipos WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nom]);

        return {
            eliminado: true,
            jugadoresEliminados: jugadores.map(j => j.filename)
        };
    } catch (err) {
        console.error('[MySQL] Error eliminarEquipo:', err.message);
        throw err;
    }
}


async function getJugadores() {
    if (!isConnected || !pool) return [];
    try {
        // Excluimos foto_blob para listados rápidos
        const [rows] = await pool.query(`
            SELECT id, nombre, equipo, filename, impreso, aprobado, qr_token, fecha_impresion, created_at, updated_at,
                   (foto_blob IS NOT NULL) AS tiene_foto_blob
            FROM jugadores
            ORDER BY equipo ASC, nombre ASC
        `);
        return rows;
    } catch (err) {
        console.error('[MySQL] Error getJugadores:', err.message);
        return [];
    }
}

async function getJugadoresPendientesAprobacion() {
    if (!isConnected || !pool) return [];
    try {
        const [rows] = await pool.query(`
            SELECT id, nombre, equipo, filename, impreso, aprobado, qr_token, created_at,
                   (foto_blob IS NOT NULL) AS tiene_foto_blob
            FROM jugadores
            WHERE aprobado = 0
            ORDER BY created_at DESC
        `);
        return rows;
    } catch (err) {
        console.error('[MySQL] Error getJugadoresPendientesAprobacion:', err.message);
        return [];
    }
}

async function aprobarJugador(filename) {
    if (!isConnected || !pool) return false;
    try {
        await pool.query('UPDATE jugadores SET aprobado = 1 WHERE filename = ?', [filename]);
        return true;
    } catch (err) {
        console.error('[MySQL] Error aprobarJugador:', err.message);
        return false;
    }
}

async function aprobarTodosJugadores() {
    if (!isConnected || !pool) return false;
    try {
        await pool.query('UPDATE jugadores SET aprobado = 1 WHERE aprobado = 0');
        return true;
    } catch (err) {
        console.error('[MySQL] Error aprobarTodosJugadores:', err.message);
        return false;
    }
}

async function getJugadorPorId(id) {
    if (!isConnected || !pool) return null;
    try {
        const [rows] = await pool.query('SELECT * FROM jugadores WHERE id = ?', [id]);
        return rows[0] || null;
    } catch (err) {
        console.error('[MySQL] Error getJugadorPorId:', err.message);
        return null;
    }
}

async function getJugadorPorToken(token) {
    if (!isConnected || !pool) return null;
    try {
        const [rows] = await pool.query('SELECT * FROM jugadores WHERE qr_token = ?', [token]);
        return rows[0] || null;
    } catch (err) {
        console.error('[MySQL] Error getJugadorPorToken:', err.message);
        return null;
    }
}

async function buscarJugadorPorNombre(nombreQuery) {
    if (!isConnected || !pool) return [];
    try {
        const [rows] = await pool.query(`
            SELECT id, nombre, equipo, filename, impreso, qr_token, fecha_impresion,
                   (foto_blob IS NOT NULL) AS tiene_foto_blob
            FROM jugadores
            WHERE LOWER(nombre) LIKE ? OR LOWER(equipo) LIKE ?
            ORDER BY nombre ASC
            LIMIT 20
        `, [`%${nombreQuery.toLowerCase()}%`, `%${nombreQuery.toLowerCase()}%`]);
        return rows;
    } catch (err) {
        console.error('[MySQL] Error buscarJugadorPorNombre:', err.message);
        return [];
    }
}

async function buscarJugadorExacto(nombreExacto, equipo = null) {
    if (!isConnected || !pool) return null;
    try {
        let query = 'SELECT * FROM jugadores WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))';
        const params = [nombreExacto];
        if (equipo) {
            query += ' AND LOWER(TRIM(equipo)) = LOWER(TRIM(?))';
            params.push(equipo);
        }
        const [rows] = await pool.query(query, params);
        return rows[0] || null;
    } catch (err) {
        console.error('[MySQL] Error buscarJugadorExacto:', err.message);
        return null;
    }
}

function generarToken() {
    return crypto.randomBytes(16).toString('hex');
}

async function upsertJugador(data) {
    if (!isConnected || !pool) return null;
    try {
        const token = data.qr_token || generarToken();
        const aprobadoVal = data.aprobado !== undefined ? (data.aprobado ? 1 : 0) : 1;
        const [result] = await pool.query(`
            INSERT INTO jugadores (nombre, equipo, filename, impreso, aprobado, foto_blob, qr_token)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                nombre = VALUES(nombre),
                equipo = VALUES(equipo),
                impreso = IF(VALUES(impreso) IS NOT NULL, VALUES(impreso), impreso),
                aprobado = IF(VALUES(aprobado) IS NOT NULL, VALUES(aprobado), aprobado),
                foto_blob = IF(VALUES(foto_blob) IS NOT NULL, VALUES(foto_blob), foto_blob),
                qr_token = IF(qr_token IS NULL OR qr_token = '', VALUES(qr_token), qr_token),
                updated_at = CURRENT_TIMESTAMP
        `, [
            data.nombre,
            data.equipo,
            data.filename,
            data.impreso ? 1 : 0,
            aprobadoVal,
            data.foto_blob || null,
            token
        ]);

        // Registrar equipo automáticamente si no existe
        await pool.query(`
            INSERT IGNORE INTO equipos (nombre, habilitado_impresion)
            VALUES (?, 1)
        `, [data.equipo]);

        const [rows] = await pool.query('SELECT id, nombre, equipo, filename, impreso, aprobado, qr_token FROM jugadores WHERE filename = ?', [data.filename]);
        return rows[0];
    } catch (err) {
        console.error('[MySQL] Error upsertJugador:', err.message);
        throw err;
    }
}

async function setJugadorImpreso(filename, impreso) {
    if (!isConnected || !pool) return false;
    try {
        const val = impreso ? 1 : 0;
        const fecha = impreso ? new Date() : null;
        await pool.query('UPDATE jugadores SET impreso = ?, fecha_impresion = ? WHERE filename = ?', [val, fecha, filename]);
        return true;
    } catch (err) {
        console.error('[MySQL] Error setJugadorImpreso:', err.message);
        return false;
    }
}

async function setVariosJugadoresImpresos(filenames, impreso) {
    if (!isConnected || !pool || !filenames || filenames.length === 0) return 0;
    try {
        const val = impreso ? 1 : 0;
        const fecha = impreso ? new Date() : null;
        const placeholders = filenames.map(() => '?').join(',');
        const [result] = await pool.query(
            `UPDATE jugadores SET impreso = ?, fecha_impresion = ? WHERE filename IN (${placeholders})`,
            [val, fecha, ...filenames]
        );
        return result.affectedRows;
    } catch (err) {
        console.error('[MySQL] Error setVariosJugadoresImpresos:', err.message);
        return 0;
    }
}

async function setTodosImpresos(impreso, soloEquiposHabilitados = false) {
    if (!isConnected || !pool) return 0;
    try {
        const val = impreso ? 1 : 0;
        const fecha = impreso ? new Date() : null;
        let query = 'UPDATE jugadores SET impreso = ?, fecha_impresion = ?';
        const params = [val, fecha];

        if (soloEquiposHabilitados) {
            query += ' WHERE equipo IN (SELECT nombre FROM equipos WHERE habilitado_impresion = 1)';
        }

        const [result] = await pool.query(query, params);
        return result.affectedRows;
    } catch (err) {
        console.error('[MySQL] Error setTodosImpresos:', err.message);
        return 0;
    }
}

async function renameJugador(oldFilename, newFilename, nuevoEquipo, nuevoNombre) {
    if (!isConnected || !pool) return false;
    try {
        await pool.query(`
            UPDATE jugadores 
            SET filename = ?, equipo = ?, nombre = ?
            WHERE filename = ?
        `, [newFilename, nuevoEquipo, nuevoNombre, oldFilename]);

        await pool.query(`
            INSERT IGNORE INTO equipos (nombre, habilitado_impresion)
            VALUES (?, 1)
        `, [nuevoEquipo]);

        return true;
    } catch (err) {
        console.error('[MySQL] Error renameJugador:', err.message);
        return false;
    }
}

async function eliminarJugador(filename) {
    if (!isConnected || !pool) return false;
    try {
        await pool.query('DELETE FROM jugadores WHERE filename = ?', [filename]);
        return true;
    } catch (err) {
        console.error('[MySQL] Error eliminarJugador:', err.message);
        return false;
    }
}

/**
 * Sincroniza bidireccionalmente los archivos locales con la base de datos MySQL.
 */
async function sincronizarConCarpeta(fotosDir, parseFilenameFn) {
    if (!isConnected || !pool) {
        throw new Error('No hay conexión con la base de datos MySQL.');
    }

    if (!fs.existsSync(fotosDir)) return { procesados: 0, insertados: 0, actualizados: 0 };

    const files = fs.readdirSync(fotosDir).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
    let insertados = 0;
    let actualizados = 0;

    for (const file of files) {
        const filePath = path.join(fotosDir, file);
        const parsed = parseFilenameFn(file);
        const buffer = fs.readFileSync(filePath);

        // Comprobar si ya existe
        const [existing] = await pool.query('SELECT id, (foto_blob IS NOT NULL) AS has_blob, qr_token FROM jugadores WHERE filename = ?', [file]);

        if (existing.length === 0) {
            const token = generarToken();
            await pool.query(`
                INSERT INTO jugadores (nombre, equipo, filename, impreso, foto_blob, qr_token)
                VALUES (?, ?, ?, 0, ?, ?)
            `, [parsed.nombre, parsed.equipo, file, buffer, token]);
            insertados++;
        } else {
            // Si no tenía el BLOB guardado en la BD, actualizarlo
            if (!existing[0].has_blob) {
                await pool.query(`
                    UPDATE jugadores SET foto_blob = ? WHERE id = ?
                `, [buffer, existing[0].id]);
                actualizados++;
            }
        }

        // Registrar equipo si no existe
        await pool.query(`
            INSERT IGNORE INTO equipos (nombre, habilitado_impresion)
            VALUES (?, 1)
        `, [parsed.equipo]);
    }

    return {
        totalArchivos: files.length,
        insertados,
        actualizados
    };
}

/**
 * Restaura fotos desde los BLOBs en la base de datos a la carpeta local
 * si los archivos físicos no existen todavía (ideal para despliegue en Alwaysdata).
 */
async function restaurarFotosDesdeBD(fotosDir) {
    if (!isConnected || !pool) return 0;
    try {
        if (!fs.existsSync(fotosDir)) {
            fs.mkdirSync(fotosDir, { recursive: true });
        }
        const [rows] = await pool.query('SELECT filename, foto_blob FROM jugadores WHERE foto_blob IS NOT NULL');
        let restauradas = 0;
        for (const row of rows) {
            if (!row.filename || !row.foto_blob) continue;
            const targetPath = path.join(fotosDir, row.filename);
            if (!fs.existsSync(targetPath)) {
                fs.writeFileSync(targetPath, row.foto_blob);
                restauradas++;
            }
        }
        if (restauradas > 0) {
            console.log(`[MySQL] Se restauraron ${restauradas} foto(s) desde la base de datos.`);
        }
        return restauradas;
    } catch (err) {
        console.warn('[MySQL] Error al restaurar fotos desde BD:', err.message);
        return 0;
    }
}

module.exports = {
    initDB,
    getStatus,
    getEquipos,
    crearEquipo,
    actualizarEquipo,
    eliminarEquipo,
    setEquipoHabilitado,
    setTodosEquiposHabilitados,
    getJugadores,
    getJugadorPorId,
    getJugadorPorToken,
    buscarJugadorPorNombre,
    buscarJugadorExacto,
    upsertJugador,
    setJugadorImpreso,
    setVariosJugadoresImpresos,
    setTodosImpresos,
    renameJugador,
    eliminarJugador,
    sincronizarConCarpeta,
    restaurarFotosDesdeBD,
    generarToken,
    getJugadoresPendientesAprobacion,
    aprobarJugador,
    aprobarTodosJugadores
};
