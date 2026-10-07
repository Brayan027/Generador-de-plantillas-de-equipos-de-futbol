const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { exec } = require('child_process');
const { generarCarnets, parseFilename, toTitleCase, autoPreprocessPhoto } = require('./generador');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.IP || '0.0.0.0';

const BASE_DIR = __dirname;
const FOTOS_DIR = path.join(BASE_DIR, 'fotos_jugadores');
const SALIDA_DIR = path.join(BASE_DIR, 'salida');
const BANNER_PATH = path.join(BASE_DIR, 'banner.png');

if (!fs.existsSync(FOTOS_DIR)) fs.mkdirSync(FOTOS_DIR, { recursive: true });
if (!fs.existsSync(SALIDA_DIR)) fs.mkdirSync(SALIDA_DIR, { recursive: true });

app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));

// Manejador seguro para capturar peticiones con JSON malformado o interrumpidas
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.warn('[Aviso] Petición con JSON malformado o incompleto recibida:', err.message);
        return res.status(400).json({ success: false, error: 'Cuerpo de petición JSON inválido o incompleto' });
    }
    next(err);
});

app.use(express.static(path.join(BASE_DIR, 'public')));
app.use('/fotos', express.static(FOTOS_DIR));
app.use('/banner.png', express.static(BANNER_PATH));

// -------------------------------------------------------------
// Seguridad y Autenticación del Panel de Administrador
// -------------------------------------------------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'SUPERV1S0R';
const activeAdminTokens = new Set();

function requireAdmin(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || '';
    const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    if (isLocalhost) {
        return next();
    }

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : (req.headers['x-admin-token'] || req.query.admin_token || req.query.token);

    if (token && activeAdminTokens.has(token)) {
        return next();
    }
    return res.status(401).json({ success: false, error: 'Acceso no autorizado. Se requiere contraseña de administrador.' });
}

app.post('/api/admin/login', (req, res) => {
    const raw = (req.body?.password || req.query?.password || '').toString().trim();
    const upper = raw.toUpperCase();
    if (upper === 'SUPERV1S0R' || upper === 'SUPERVISOR' || raw === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        activeAdminTokens.add(token);
        return res.json({ success: true, token });
    }
    return res.status(401).json({ success: false, error: 'Contraseña incorrecta. Debe ser SUPERV1S0R' });
});

app.post('/api/admin/verificar', (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : (req.headers['x-admin-token'] || req.query.admin_token);

    if (token && activeAdminTokens.has(token)) {
        return res.json({ success: true, valid: true });
    }
    return res.status(401).json({ success: false, valid: false });
});

app.post('/api/admin/logout', (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : (req.headers['x-admin-token'] || req.query.admin_token);

    if (token) activeAdminTokens.delete(token);
    return res.json({ success: true });
});

// Configuración de Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, FOTOS_DIR);
    },
    filename: (req, file, cb) => {
        const rawName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const parsed = parseFilename(rawName);
        const ext = path.extname(rawName);
        const finalName = `${parsed.equipo} - ${parsed.nombre}${ext}`;
        cb(null, finalName);
    }
});
const upload = multer({ storage });

// Helper para obtener URL base dinámica (IP local o host)
function getBaseUrl(req) {
    const host = req.get('host') || `localhost:${PORT}`;
    const proto = req.protocol || 'http';
    return `${proto}://${host}`;
}

// -------------------------------------------------------------
// 1. Estado y Sincronización de Base de Datos (ADMIN)
// -------------------------------------------------------------
app.get('/api/status-db', requireAdmin, async (req, res) => {
    try {
        const status = db.getStatus();
        const equipos = await db.getEquipos();
        const jugadores = await db.getJugadores();
        res.json({
            success: true,
            status,
            totalEquipos: equipos.length,
            totalJugadores: jugadores.length
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/sincronizar-bd', requireAdmin, async (req, res) => {
    try {
        const resultado = await db.sincronizarConCarpeta(FOTOS_DIR, parseFilename);
        res.json({ success: true, resultado });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 2. Gestión de Equipos (Habilitar / Inhabilitar para Impresión)
// -------------------------------------------------------------
app.get('/api/equipos', async (req, res) => {
    try {
        const dbEquipos = await db.getEquipos();
        const files = fs.readdirSync(FOTOS_DIR).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
        const dbJugadores = await db.getJugadores();
        const jugadorMap = new Map();
        dbJugadores.forEach(j => jugadorMap.set(j.filename, j));

        // Mapear equipos con conteo real de jugadores
        const equiposMap = new Map();

        // Inicializar con los equipos de la base de datos
        dbEquipos.forEach(eq => {
            equiposMap.set(eq.nombre, {
                id: eq.id,
                nombre: eq.nombre,
                habilitado: eq.habilitado_impresion === 1,
                totalJugadores: 0,
                impresos: 0,
                pendientes: 0
            });
        });

        // Contar jugadores por equipo
        files.forEach(f => {
            const parsed = parseFilename(f);
            const jdb = jugadorMap.get(f);
            const esImpreso = jdb ? jdb.impreso === 1 : false;

            if (!equiposMap.has(parsed.equipo)) {
                equiposMap.set(parsed.equipo, {
                    id: null,
                    nombre: parsed.equipo,
                    habilitado: true,
                    totalJugadores: 0,
                    impresos: 0,
                    pendientes: 0
                });
            }

            const item = equiposMap.get(parsed.equipo);
            item.totalJugadores++;
            if (esImpreso) item.impresos++;
            else item.pendientes++;
        });

        const equipos = Array.from(equiposMap.values()).sort((a, b) =>
            a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' })
        );

        res.json({ success: true, equipos });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/equipos/toggle', requireAdmin, async (req, res) => {
    try {
        const { nombre, habilitado } = req.body;
        if (!nombre) return res.status(400).json({ success: false, error: 'Falta nombre del equipo' });
        await db.setEquipoHabilitado(nombre, habilitado);
        res.json({ success: true, nombre, habilitado });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/equipos/toggle-todos', requireAdmin, async (req, res) => {
    try {
        const { habilitado } = req.body;
        await db.setTodosEquiposHabilitados(habilitado);
        res.json({ success: true, habilitado });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Crear nuevo equipo
app.post('/api/equipos', requireAdmin, async (req, res) => {
    try {
        const { nombre, habilitado } = req.body;
        if (!nombre || !nombre.trim()) {
            return res.status(400).json({ success: false, error: 'El nombre del equipo es obligatorio.' });
        }
        const nomFinal = toTitleCase(nombre.trim().slice(0, 35), true);
        const result = await db.crearEquipo(nomFinal, habilitado !== undefined ? habilitado : true);
        res.json({
            success: true,
            equipo: {
                id: result.id,
                nombre: nomFinal,
                habilitado: result.habilitado !== 0,
                totalJugadores: 0,
                impresos: 0,
                pendientes: 0
            }
        });
    } catch (err) {
        res.status(err.code === 'EQUIPO_DUPLICADO' ? 400 : 500).json({ success: false, error: err.message, code: err.code });
    }
});

// Modificar / actualizar equipo
app.put('/api/equipos/:nombre', requireAdmin, async (req, res) => {
    try {
        const oldNombre = decodeURIComponent(req.params.nombre).trim();
        const { nuevoNombre, habilitado } = req.body;

        if (!oldNombre) {
            return res.status(400).json({ success: false, error: 'Falta especificar el equipo a modificar.' });
        }

        const nomFinal = (nuevoNombre && nuevoNombre.trim())
            ? toTitleCase(nuevoNombre.trim().slice(0, 35), true)
            : oldNombre;
        const nombreCambio = nomFinal.toLowerCase() !== oldNombre.toLowerCase();

        // Si cambió el nombre, renombrar los archivos en fotos_jugadores y en la BD
        if (nombreCambio) {
            const files = fs.readdirSync(FOTOS_DIR).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
            for (const file of files) {
                const parsed = parseFilename(file);
                if (parsed.equipo.toLowerCase() === oldNombre.toLowerCase()) {
                    const ext = path.extname(file);
                    const newFilename = `${nomFinal} - ${parsed.nombre}${ext}`;
                    const oldPath = path.join(FOTOS_DIR, file);
                    const newPath = path.join(FOTOS_DIR, newFilename);
                    if (oldPath !== newPath && fs.existsSync(oldPath)) {
                        fs.renameSync(oldPath, newPath);
                    }
                    await db.renameJugador(file, newFilename, nomFinal, parsed.nombre);
                }
            }
        }

        await db.actualizarEquipo(oldNombre, nomFinal, habilitado);

        res.json({
            success: true,
            oldNombre,
            nombre: nomFinal,
            habilitado: habilitado !== undefined ? !!habilitado : undefined
        });
    } catch (err) {
        res.status(err.code === 'EQUIPO_DUPLICADO' ? 400 : 500).json({ success: false, error: err.message, code: err.code });
    }
});

// Eliminar equipo
app.delete('/api/equipos/:nombre', requireAdmin, async (req, res) => {
    try {
        const nombre = decodeURIComponent(req.params.nombre).trim();
        const eliminarJugadores = req.query.eliminarJugadores === 'true' || req.body?.eliminarJugadores === true;

        const files = fs.readdirSync(FOTOS_DIR).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
        const archivosEquipo = files.filter(f => parseFilename(f).equipo.toLowerCase() === nombre.toLowerCase());

        let totalJugadores = archivosEquipo.length;
        try {
            const dbJugadores = await db.getJugadores();
            const dbEquipoJugadores = dbJugadores.filter(j => (j.equipo || '').toLowerCase() === nombre.toLowerCase());
            totalJugadores = Math.max(totalJugadores, dbEquipoJugadores.length);
        } catch (e) {}

        if (totalJugadores > 0 && !eliminarJugadores) {
            return res.status(400).json({
                success: false,
                code: 'EQUIPO_CON_JUGADORES',
                totalJugadores,
                error: `El equipo "${nombre}" tiene ${totalJugadores} jugador(es). Confirma si deseas eliminarlos.`
            });
        }

        // Si se confirma eliminar con jugadores, borrar archivos físicos
        if (eliminarJugadores) {
            archivosEquipo.forEach(f => {
                try {
                    const p = path.join(FOTOS_DIR, f);
                    if (fs.existsSync(p)) fs.unlinkSync(p);
                } catch (e) {
                    console.error('Error al borrar foto:', f, e.message);
                }
            });
        }

        const resDB = await db.eliminarEquipo(nombre, eliminarJugadores);

        res.json({
            success: true,
            nombre,
            jugadoresEliminados: totalJugadores || (resDB?.jugadoresEliminados?.length || 0)
        });
    } catch (err) {
        res.status(err.code === 'EQUIPO_CON_JUGADORES' ? 400 : 500).json({
            success: false,
            error: err.message,
            code: err.code,
            totalJugadores: err.totalJugadores
        });
    }
});

// -------------------------------------------------------------
// 3. Lista de Jugadores (combinada con BD y archivos - ADMIN)
// -------------------------------------------------------------
app.get('/api/jugadores', requireAdmin, async (req, res) => {
    try {
        const files = fs.readdirSync(FOTOS_DIR).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
        const dbJugadores = await db.getJugadores();
        const dbEquipos = await db.getEquipos();

        const jMap = new Map();
        dbJugadores.forEach(j => jMap.set(j.filename, j));

        const eqHabilitadoMap = new Map();
        dbEquipos.forEach(e => eqHabilitadoMap.set(e.nombre, e.habilitado_impresion === 1));

        const jugadores = files.map(file => {
            const parsed = parseFilename(file);
            const stat = fs.statSync(path.join(FOTOS_DIR, file));
            const jdb = jMap.get(file);

            const equipoHabilitado = eqHabilitadoMap.has(parsed.equipo) 
                ? eqHabilitadoMap.get(parsed.equipo) 
                : true;

            const aprobado = jdb ? (jdb.aprobado === 1) : true;

            return {
                id: jdb ? jdb.id : null,
                filename: file,
                url: `/fotos/${encodeURIComponent(file)}?t=${stat.mtimeMs}`,
                urlCarnet: `/api/foto-carnet/${encodeURIComponent(file)}?t=${stat.mtimeMs}`,
                equipo: parsed.equipo,
                nombre: parsed.nombre,
                impreso: jdb ? jdb.impreso === 1 : false,
                aprobado,
                fechaImpresion: jdb ? jdb.fecha_impresion : null,
                qrToken: jdb ? jdb.qr_token : null,
                equipoHabilitado,
                size: stat.size,
                mtime: stat.mtime
            };
        });

        const totalPendientesAprobacion = jugadores.filter(j => !j.aprobado).length;

        // Lista oficial de jugadores aprobados para impresión y planillas
        const jugadoresAprobados = jugadores.filter(j => j.aprobado);

        // Ordenar por equipo y luego por nombre
        jugadoresAprobados.sort((a, b) => {
            const compEq = a.equipo.localeCompare(b.equipo, 'es', { sensitivity: 'base' });
            if (compEq !== 0) return compEq;
            return a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' });
        });

        res.json({
            success: true,
            jugadores: jugadoresAprobados,
            totalPendientesAprobacion
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Foto centrada inteligentemente
app.get('/api/foto-carnet/:filename', async (req, res) => {
    try {
        const filePath = path.join(FOTOS_DIR, req.params.filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).send('Foto no encontrada');
        }
        const raw = fs.readFileSync(filePath);
        const clean = await autoPreprocessPhoto(raw);
        const buf = await sharp(clean)
            .resize(400, 440, { fit: 'cover', position: sharp.strategy.attention, kernel: 'lanczos3' })
            .jpeg({ quality: 92 })
            .toBuffer();
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(buf);
    } catch (err) {
        res.sendFile(path.join(FOTOS_DIR, req.params.filename));
    }
});

// -------------------------------------------------------------
// 4. Marcar Jugadores como Impresos
// -------------------------------------------------------------
app.post('/api/jugador/impreso', requireAdmin, async (req, res) => {
    try {
        const { filename, impreso } = req.body;
        if (!filename) return res.status(400).json({ success: false, error: 'Falta filename' });

        await db.setJugadorImpreso(filename, impreso);
        res.json({ success: true, filename, impreso: !!impreso });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/jugadores/marcar-todos', requireAdmin, async (req, res) => {
    try {
        const { impreso, filenames, soloEquiposHabilitados } = req.body;
        if (Array.isArray(filenames) && filenames.length > 0) {
            const count = await db.setVariosJugadoresImpresos(filenames, impreso);
            res.json({ success: true, afectaron: count });
        } else {
            const count = await db.setTodosImpresos(impreso, !!soloEquiposHabilitados);
            res.json({ success: true, afectaron: count });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 4.1 Aprobación y Gestión de Solicitudes de Registro (ADMIN)
// -------------------------------------------------------------
app.get('/api/jugadores/pendientes-aprobacion', requireAdmin, async (req, res) => {
    try {
        const pendientes = await db.getJugadoresPendientesAprobacion();
        const lista = pendientes.map(j => {
            const parsed = parseFilename(j.filename);
            return {
                id: j.id,
                filename: j.filename,
                url: `/fotos/${encodeURIComponent(j.filename)}`,
                urlCarnet: `/api/foto-carnet/${encodeURIComponent(j.filename)}`,
                equipo: j.equipo || parsed.equipo,
                nombre: j.nombre || parsed.nombre,
                qrToken: j.qr_token,
                createdAt: j.created_at
            };
        });
        res.json({ success: true, total: lista.length, pendientes: lista });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/jugador/aprobar', requireAdmin, async (req, res) => {
    try {
        const { filename } = req.body;
        if (!filename) return res.status(400).json({ success: false, error: 'Falta filename' });
        await db.aprobarJugador(filename);
        res.json({ success: true, filename });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/jugadores/aprobar-todos', requireAdmin, async (req, res) => {
    try {
        await db.aprobarTodosJugadores();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/jugador/rechazar', requireAdmin, async (req, res) => {
    try {
        const { filename } = req.body;
        if (!filename) return res.status(400).json({ success: false, error: 'Falta filename' });
        await db.eliminarJugador(filename);
        const fPath = path.join(FOTOS_DIR, filename);
        if (fs.existsSync(fPath)) {
            try { fs.unlinkSync(fPath); } catch (e) {}
        }
        res.json({ success: true, filename });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 5. Búsqueda y Validación Rápida de Jugadores
// -------------------------------------------------------------
app.get('/api/jugador/buscar', async (req, res) => {
    try {
        const query = (req.query.q || '').trim();
        if (!query) return res.json({ success: true, resultados: [] });

        const resultados = await db.buscarJugadorPorNombre(query);
        const baseUrl = getBaseUrl(req);

        const list = await Promise.all(resultados.map(async j => {
            const qrUrl = `${baseUrl}/carnet/${j.qr_token || j.id}`;
            const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 220, margin: 1 });
            return {
                id: j.id,
                nombre: j.nombre,
                equipo: j.equipo,
                filename: j.filename,
                url: `/fotos/${encodeURIComponent(j.filename)}`,
                urlCarnet: `/api/foto-carnet/${encodeURIComponent(j.filename)}`,
                impreso: j.impreso === 1,
                qrToken: j.qr_token,
                qrDataUrl,
                carnetUrl: qrUrl
            };
        }));

        res.json({ success: true, resultados: list });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Registro Rápido (con foto de webcam o subida)
app.post('/api/jugador/registrar-rapido', async (req, res) => {
    try {
        const { nombre, equipo, fotoBase64 } = req.body;
        if (!nombre || !equipo) {
            return res.status(400).json({ success: false, error: 'Nombre y equipo son obligatorios' });
        }

        const nomFinal = toTitleCase(nombre.trim().slice(0, 42), false);
        const eqFinal = toTitleCase(equipo.trim().slice(0, 35), true);
        const filename = `${eqFinal} - ${nomFinal}.jpg`;
        const filePath = path.join(FOTOS_DIR, filename);

        let imgBuffer = null;
        if (fotoBase64) {
            const matches = fotoBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            imgBuffer = matches ? Buffer.from(matches[2], 'base64') : Buffer.from(fotoBase64, 'base64');
        }

        if (imgBuffer) {
            // Auto-procesar imagen con nitidez y rotación
            const clean = await autoPreprocessPhoto(imgBuffer);
            const jpegBuf = await sharp(clean)
                .jpeg({ quality: 95 })
                .toBuffer();
            fs.writeFileSync(filePath, jpegBuf);
            imgBuffer = jpegBuf;
        }

        const esAdmin = req.body.admin === true;
        const aprobado = esAdmin ? 1 : 0;

        const qrToken = db.generarToken();
        const jugador = await db.upsertJugador({
            nombre: nomFinal,
            equipo: eqFinal,
            filename,
            impreso: 0,
            aprobado,
            foto_blob: imgBuffer,
            qr_token: qrToken
        });

        const baseUrl = getBaseUrl(req);
        const carnetUrl = `${baseUrl}/carnet/${qrToken}`;
        const qrDataUrl = await QRCode.toDataURL(carnetUrl, { width: 260, margin: 1 });

        res.json({
            success: true,
            aprobado: aprobado === 1,
            jugador: {
                id: jugador.id,
                nombre: nomFinal,
                equipo: eqFinal,
                filename,
                url: `/fotos/${encodeURIComponent(filename)}`,
                urlCarnet: `/api/foto-carnet/${encodeURIComponent(filename)}`,
                aprobado: aprobado === 1,
                qrToken,
                qrDataUrl,
                carnetUrl
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 6. Rutas de Páginas
// -------------------------------------------------------------
app.get(['/', '/portal', '/registro', '/consulta'], (req, res) => {
    res.sendFile(path.join(BASE_DIR, 'public', 'index.html'));
});

app.get(['/admin', '/panel'], (req, res) => {
    res.sendFile(path.join(BASE_DIR, 'public', 'admin.html'));
});

app.get('/carnet/:token', (req, res) => {
    res.sendFile(path.join(BASE_DIR, 'public', 'carnet.html'));
});

app.get('/api/carnet-data/:token', async (req, res) => {
    try {
        const token = req.params.token;
        let jugador = await db.getJugadorPorToken(token);
        if (!jugador && !isNaN(token)) {
            jugador = await db.getJugadorPorId(parseInt(token, 10));
        }

        if (!jugador) {
            return res.status(404).json({ success: false, error: 'Carnet no encontrado' });
        }

        const baseUrl = getBaseUrl(req);
        const carnetUrl = `${baseUrl}/carnet/${jugador.qr_token || jugador.id}`;

        res.json({
            success: true,
            jugador: {
                id: jugador.id,
                nombre: jugador.nombre,
                equipo: jugador.equipo,
                filename: jugador.filename,
                url: `/fotos/${encodeURIComponent(jugador.filename)}`,
                urlCarnet: `/api/foto-carnet/${encodeURIComponent(jugador.filename)}`,
                impreso: jugador.impreso === 1,
                aprobado: jugador.aprobado === 1,
                qrToken: jugador.qr_token
            },
            carnetUrl
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Generación y descarga directa del carnet como imagen PNG (Sharp)
app.get('/api/carnet/descargar-imagen/:token', async (req, res) => {
    try {
        const token = req.params.token;
        let jugador = await db.getJugadorPorToken(token);
        if (!jugador && !isNaN(token)) {
            jugador = await db.getJugadorPorId(parseInt(token, 10));
        }

        if (!jugador) {
            return res.status(404).send('Carnet no encontrado');
        }

        const width = 640;
        const height = 840;

        // Foto del jugador
        const photoPath = path.join(FOTOS_DIR, jugador.filename);
        let photoBuf = null;
        if (fs.existsSync(photoPath)) {
            photoBuf = fs.readFileSync(photoPath);
        } else if (jugador.foto_blob) {
            photoBuf = jugador.foto_blob;
        }

        let photoResized = null;
        if (photoBuf) {
            const clean = await autoPreprocessPhoto(photoBuf);
            photoResized = await sharp(clean)
                .resize(270, 320, { fit: 'cover', position: sharp.strategy.attention })
                .toBuffer();
        }

        // Banner
        let bannerResized = null;
        if (fs.existsSync(BANNER_PATH)) {
            bannerResized = await sharp(BANNER_PATH)
                .resize(600, 115, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
                .toBuffer();
        }

        // Crear SVG para textos y diseño
        const safeNombre = (jugador.nombre || '').toUpperCase().slice(0, 32);
        const safeEquipo = (jugador.equipo || '').toUpperCase().slice(0, 28);
        const svgOverlay = Buffer.from(`
            <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
                <!-- Borde de foto -->
                <rect x="183" y="168" width="274" height="324" rx="14" fill="none" stroke="#10b981" stroke-width="4" />
                <!-- Línea separadora -->
                <line x1="20" y1="142" x2="620" y2="142" stroke="#10b981" stroke-width="3" />
                <!-- Nombre -->
                <text x="320" y="540" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="28" fill="#0f172a" text-anchor="middle">${safeNombre.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>
                <!-- Equipo Badge -->
                <rect x="120" y="575" width="400" height="42" rx="21" fill="#ecfdf5" stroke="#a7f3d0" stroke-width="2" />
                <text x="320" y="603" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="20" fill="#065f46" text-anchor="middle">${safeEquipo.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>
                <!-- Estado Badge -->
                <rect x="80" y="645" width="480" height="48" rx="12" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5" />
                <text x="320" y="675" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="16" fill="#059669" text-anchor="middle">CARNET OFICIAL HABILITADO</text>
                <!-- Footer -->
                <text x="320" y="750" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="13" fill="#64748b" text-anchor="middle">TORNEO DE FÚTBOL SAN ANTONIO · CARNET DIGITAL</text>
            </svg>
        `);

        const composites = [
            { input: Buffer.from(`<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff" stroke="#e2e8f0" stroke-width="6"/></svg>`), top: 0, left: 0 }
        ];

        if (bannerResized) {
            composites.push({ input: bannerResized, top: 16, left: 20 });
        }

        if (photoResized) {
            composites.push({ input: photoResized, top: 170, left: 185 });
        }

        composites.push({ input: svgOverlay, top: 0, left: 0 });

        const finalImage = await sharp({
            create: {
                width,
                height,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            }
        })
        .composite(composites)
        .png({ quality: 95 })
        .toBuffer();

        const safeFilename = `Carnet_${(jugador.nombre || 'Jugador').replace(/[^a-zA-Z0-9_\-]/g, '_')}.png`;
        res.set('Content-Disposition', `attachment; filename="${safeFilename}"`);
        res.set('Content-Type', 'image/png');
        res.send(finalImage);
    } catch (err) {
        console.error('Error generando imagen de carnet:', err);
        res.status(500).send('Error generando imagen del carnet: ' + err.message);
    }
});

// -------------------------------------------------------------
// 7. Subida masiva de fotos (con sincronización inmediata a MySQL)
// -------------------------------------------------------------
// -------------------------------------------------------------
// 7. Subida masiva de fotos (con sincronización inmediata a MySQL - ADMIN)
// -------------------------------------------------------------
app.post('/api/upload', requireAdmin, upload.array('fotos', 100), async (req, res) => {
    try {
        const subidos = [];
        for (const f of (req.files || [])) {
            let bufferFinal = null;
            try {
                const fPath = path.join(FOTOS_DIR, f.filename);
                const raw = fs.readFileSync(fPath);
                const clean = await autoPreprocessPhoto(raw);
                if (clean && clean.length !== raw.length) {
                    fs.writeFileSync(fPath, clean);
                    bufferFinal = clean;
                } else {
                    bufferFinal = raw;
                }
            } catch (e) {
                bufferFinal = fs.readFileSync(path.join(FOTOS_DIR, f.filename));
            }

            const parsed = parseFilename(f.filename);

            // Guardar en MySQL
            try {
                await db.upsertJugador({
                    nombre: parsed.nombre,
                    equipo: parsed.equipo,
                    filename: f.filename,
                    impreso: 0,
                    foto_blob: bufferFinal
                });
            } catch (errDb) {
                console.warn('[MySQL] Advertencia al guardar jugador:', errDb.message);
            }

            subidos.push({
                filename: f.filename,
                url: `/fotos/${encodeURIComponent(f.filename)}`,
                urlCarnet: `/api/foto-carnet/${encodeURIComponent(f.filename)}`,
                equipo: parsed.equipo,
                nombre: parsed.nombre
            });
        }
        res.json({ success: true, count: subidos.length, jugadores: subidos });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Recortar foto (ADMIN)
app.post('/api/recortar', requireAdmin, async (req, res) => {
    try {
        const { filename, crop } = req.body;
        if (!filename || !crop) {
            return res.status(400).json({ success: false, error: 'Parámetros incompletos' });
        }
        const filePath = path.join(FOTOS_DIR, filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: 'Foto no encontrada' });
        }
        const raw = fs.readFileSync(filePath);
        const meta = await sharp(raw).metadata();
        const left = Math.max(0, Math.min(meta.width - 20, Math.round(crop.left)));
        const top = Math.max(0, Math.min(meta.height - 20, Math.round(crop.top)));
        const width = Math.min(meta.width - left, Math.round(crop.width));
        const height = Math.min(meta.height - top, Math.round(crop.height));

        const cropped = await sharp(raw)
            .extract({ left, top, width, height })
            .jpeg({ quality: 98 })
            .toBuffer();

        fs.writeFileSync(filePath, cropped);

        // Actualizar blob en MySQL
        try {
            const parsed = parseFilename(filename);
            await db.upsertJugador({
                nombre: parsed.nombre,
                equipo: parsed.equipo,
                filename,
                foto_blob: cropped
            });
        } catch (e) {}

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Actualizar datos (ADMIN)
app.post('/api/actualizar', requireAdmin, async (req, res) => {
    try {
        const { oldFilename, nuevoEquipo, nuevoNombre } = req.body;
        if (!oldFilename || !nuevoEquipo || !nuevoNombre) {
            return res.status(400).json({ success: false, error: 'Faltan parámetros' });
        }

        const ext = path.extname(oldFilename);
        const eqFinal = toTitleCase(nuevoEquipo.trim().slice(0, 35), true);
        const nomFinal = toTitleCase(nuevoNombre.trim().slice(0, 42), false);
        const newFilename = `${eqFinal} - ${nomFinal}${ext}`;

        const oldPath = path.join(FOTOS_DIR, oldFilename);
        const newPath = path.join(FOTOS_DIR, newFilename);

        if (oldPath !== newPath && fs.existsSync(oldPath)) {
            fs.renameSync(oldPath, newPath);
        }

        // Actualizar en MySQL
        await db.renameJugador(oldFilename, newFilename, eqFinal, nomFinal);

        res.json({ success: true, newFilename, equipo: eqFinal, nombre: nomFinal });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Eliminar jugador (ADMIN)
app.delete('/api/jugador/:filename', requireAdmin, async (req, res) => {
    try {
        const filePath = path.join(FOTOS_DIR, req.params.filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        await db.eliminarJugador(req.params.filename);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Vaciar fotos (ADMIN)
app.post('/api/limpiar', requireAdmin, async (req, res) => {
    try {
        const files = fs.readdirSync(FOTOS_DIR).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
        files.forEach(f => {
            try { fs.unlinkSync(path.join(FOTOS_DIR, f)); } catch (e) {}
        });
        for (const f of files) {
            await db.eliminarJugador(f);
        }
        res.json({ success: true, eliminados: files.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// 8. Generar Word y PDF con filtros inteligentes (ADMIN)
// -------------------------------------------------------------
app.post('/api/generar', requireAdmin, async (req, res) => {
    try {
        if (req.setTimeout) req.setTimeout(180000);
        if (res.setTimeout) res.setTimeout(180000);
        const { soloPendientes, autoMarcarImpresos = true } = req.body || {};

        const files = fs.readdirSync(FOTOS_DIR).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
        const dbJugadores = await db.getJugadores();
        const dbEquipos = await db.getEquipos();

        const jMap = new Map();
        dbJugadores.forEach(j => jMap.set(j.filename, j));

        const eqHabilitadoMap = new Map();
        dbEquipos.forEach(e => eqHabilitadoMap.set(e.nombre, e.habilitado_impresion === 1));

        // Filtrar según equipos habilitados y estado impreso
        const jugadoresAImprimir = [];
        const filenamesImpresos = [];

        for (const file of files) {
            const parsed = parseFilename(file);
            const esHabilitado = eqHabilitadoMap.has(parsed.equipo)
                ? eqHabilitadoMap.get(parsed.equipo)
                : true;

            // Si el equipo está inhabilitado, no imprimir
            if (!esHabilitado) continue;

            const jdb = jMap.get(file);
            const estaAprobado = jdb ? jdb.aprobado === 1 : true;
            if (!estaAprobado) continue;

            const estaImpreso = jdb ? jdb.impreso === 1 : false;

            // Si se pidió solo pendientes y ya está impreso, omitir
            if (soloPendientes && estaImpreso) continue;

            jugadoresAImprimir.push({
                filename: file,
                filePath: path.join(FOTOS_DIR, file),
                equipo: parsed.equipo,
                nombre: parsed.nombre
            });
            filenamesImpresos.push(file);
        }

        if (jugadoresAImprimir.length === 0) {
            return res.json({
                success: false,
                message: soloPendientes
                    ? 'No hay jugadores pendientes para imprimir en los equipos habilitados.'
                    : 'No hay jugadores para imprimir en los equipos habilitados.'
            });
        }

        const resultado = await generarCarnets({
            baseDir: BASE_DIR,
            fotosDir: FOTOS_DIR,
            salidaDir: SALIDA_DIR,
            bannerPath: BANNER_PATH,
            jugadores: jugadoresAImprimir
        });

        // Marcar automáticamente como impresos si la opción está activa
        if (resultado.success && autoMarcarImpresos && filenamesImpresos.length > 0) {
            await db.setVariosJugadoresImpresos(filenamesImpresos, true);
        }

        res.json({
            ...resultado,
            jugadoresImpresosCount: filenamesImpresos.length,
            marcadosComoImpresos: !!autoMarcarImpresos
        });
    } catch (err) {
        console.error("Error al generar:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Descargas y Apertura (ADMIN)
app.get('/api/descargar/docx', requireAdmin, (req, res) => {
    const docxPath = path.join(SALIDA_DIR, 'Carnets_Torneo.docx');
    if (fs.existsSync(docxPath)) {
        res.setHeader('Content-Disposition', 'attachment; filename="Carnets_Torneo.docx"');
        res.download(docxPath, 'Carnets_Torneo.docx');
    } else {
        res.status(404).send('Archivo Word no encontrado.');
    }
});

app.get('/api/descargar/pdf', requireAdmin, (req, res) => {
    const pdfPath = path.join(SALIDA_DIR, 'Carnets_Torneo.pdf');
    if (fs.existsSync(pdfPath)) {
        res.setHeader('Content-Disposition', 'attachment; filename="Carnets_Torneo.pdf"');
        res.download(pdfPath, 'Carnets_Torneo.pdf');
    } else {
        const docxPath = path.join(SALIDA_DIR, 'Carnets_Torneo.docx');
        if (fs.existsSync(docxPath)) {
            res.setHeader('Content-Disposition', 'attachment; filename="Carnets_Torneo.docx"');
            res.download(docxPath, 'Carnets_Torneo.docx');
        } else {
            res.status(404).send('Archivo no encontrado.');
        }
    }
});

app.post('/api/abrir', requireAdmin, (req, res) => {
    const { tipo } = req.body;
    let cmd = '';

    if (tipo === 'docx') {
        const p = path.join(SALIDA_DIR, 'Carnets_Torneo.docx');
        cmd = `start "" "${p}"`;
    } else if (tipo === 'pdf') {
        const p = path.join(SALIDA_DIR, 'Carnets_Torneo.pdf');
        cmd = `start "" "${p}"`;
    } else if (tipo === 'salida') {
        cmd = `explorer.exe "${SALIDA_DIR}"`;
    } else if (tipo === 'fotos') {
        cmd = `explorer.exe "${FOTOS_DIR}"`;
    }

    if (cmd) {
        exec(cmd, (err) => {
            if (err) console.error("Error abriendo:", err);
        });
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Tipo inválido' });
    }
});

// Middleware global de captura de errores Express
app.use((err, req, res, next) => {
    console.error('[Error no controlado]:', err);
    if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Ocurrió un error inesperado en el servidor.' });
    }
});

// Arrancar servidor inmediatamente y conectar DB
const server = app.listen(PORT, HOST, () => {
    console.log(`=======================================================`);
    console.log(` Servidor de Carnets iniciado en: http://${HOST}:${PORT}`);
    console.log(` Carpeta de fotos: ${FOTOS_DIR}`);
    console.log(` Carpeta de salida: ${SALIDA_DIR}`);
    console.log(` Entorno: Listo para Alwaysdata`);
    console.log(`=======================================================`);

    // Inicializar BD en segundo plano y restaurar fotos si es necesario
    (async () => {
        try {
            await db.initDB();
            await db.restaurarFotosDesdeBD(FOTOS_DIR);
            await db.sincronizarConCarpeta(FOTOS_DIR, parseFilename);
            console.log('[Servidor] Base de datos MySQL y fotos sincronizadas correctamente.');
        } catch (e) {
            console.warn('[Aviso DB]:', e.message);
        }
    })();
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`\n[Aviso] El servidor ya está activo en http://${HOST}:${PORT}\n`);
    } else {
        console.error('Error al iniciar servidor:', err);
    }
});

process.on('uncaughtException', (err) => {
    console.error('[Uncaught Exception]:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Unhandled Rejection]:', reason);
});

