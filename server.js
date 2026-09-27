const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { exec } = require('child_process');
const { generarCarnets, parseFilename, toTitleCase, autoPreprocessPhoto } = require('./generador');

const app = express();
const PORT = 3000;

const BASE_DIR = __dirname;
const FOTOS_DIR = path.join(BASE_DIR, 'fotos_jugadores');
const SALIDA_DIR = path.join(BASE_DIR, 'salida');
const BANNER_PATH = path.join(BASE_DIR, 'banner.png');

if (!fs.existsSync(FOTOS_DIR)) fs.mkdirSync(FOTOS_DIR, { recursive: true });
if (!fs.existsSync(SALIDA_DIR)) fs.mkdirSync(SALIDA_DIR, { recursive: true });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(BASE_DIR, 'public')));
app.use('/fotos', express.static(FOTOS_DIR));
app.use('/banner.png', express.static(BANNER_PATH));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, FOTOS_DIR);
    },
    filename: (req, file, cb) => {
        const rawName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const parsed = parseFilename(rawName);
        const ext = path.extname(rawName);
        // Guardar con formato limpio y Title Case
        const finalName = `${parsed.equipo} - ${parsed.nombre}${ext}`;
        cb(null, finalName);
    }
});
const upload = multer({ storage });

// 1. Lista de jugadores
app.get('/api/jugadores', (req, res) => {
    try {
        const files = fs.readdirSync(FOTOS_DIR).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
        const jugadores = files.map(file => {
            const parsed = parseFilename(file);
            const stat = fs.statSync(path.join(FOTOS_DIR, file));
            return {
                filename: file,
                url: `/fotos/${encodeURIComponent(file)}?t=${stat.mtimeMs}`,
                urlCarnet: `/api/foto-carnet/${encodeURIComponent(file)}?t=${stat.mtimeMs}`,
                equipo: parsed.equipo,
                nombre: parsed.nombre,
                size: stat.size,
                mtime: stat.mtime
            };
        });

        // Ordenar por equipo y luego por nombre
        jugadores.sort((a, b) => {
            const compEq = a.equipo.localeCompare(b.equipo, 'es', { sensitivity: 'base' });
            if (compEq !== 0) return compEq;
            return a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' });
        });

        res.json({ success: true, jugadores });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint para servir foto centrada inteligentemente en el rostro
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

// 2. Subir fotos (con auto-limpieza inteligente de franjas y tarjetas)
app.post('/api/upload', upload.array('fotos', 100), async (req, res) => {
    try {
        const subidos = [];
        for (const f of (req.files || [])) {
            try {
                const fPath = path.join(FOTOS_DIR, f.filename);
                const raw = fs.readFileSync(fPath);
                const clean = await autoPreprocessPhoto(raw);
                if (clean && clean.length !== raw.length) {
                    fs.writeFileSync(fPath, clean);
                }
            } catch (e) {}

            const parsed = parseFilename(f.filename);
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

// Endpoint para recortar o reencuadrar manualmente cualquier foto desde el panel web
app.post('/api/recortar', async (req, res) => {
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
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Actualizar datos (aplica Title Case a mayúsculas iniciales)
app.post('/api/actualizar', (req, res) => {
    try {
        const { oldFilename, nuevoEquipo, nuevoNombre } = req.body;
        if (!oldFilename || !nuevoEquipo || !nuevoNombre) {
            return res.status(400).json({ success: false, error: 'Faltan parámetros' });
        }

        const ext = path.extname(oldFilename);
        const eqFinal = toTitleCase(nuevoEquipo.trim(), true);
        const nomFinal = toTitleCase(nuevoNombre.trim(), false);
        const newFilename = `${eqFinal} - ${nomFinal}${ext}`;

        const oldPath = path.join(FOTOS_DIR, oldFilename);
        const newPath = path.join(FOTOS_DIR, newFilename);

        if (oldPath !== newPath && fs.existsSync(oldPath)) {
            fs.renameSync(oldPath, newPath);
        }

        res.json({ success: true, newFilename, equipo: eqFinal, nombre: nomFinal });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Eliminar
app.delete('/api/jugador/:filename', (req, res) => {
    try {
        const filePath = path.join(FOTOS_DIR, req.params.filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. Vaciar fotos
app.post('/api/limpiar', (req, res) => {
    try {
        const files = fs.readdirSync(FOTOS_DIR).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
        files.forEach(f => fs.unlinkSync(path.join(FOTOS_DIR, f)));
        res.json({ success: true, eliminados: files.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. Generar Word y PDF
app.post('/api/generar', async (req, res) => {
    try {
        const resultado = await generarCarnets({
            baseDir: BASE_DIR,
            fotosDir: FOTOS_DIR,
            salidaDir: SALIDA_DIR,
            bannerPath: BANNER_PATH
        });

        res.json(resultado);
    } catch (err) {
        console.error("Error al generar:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 7. Descargar
app.get('/api/descargar/docx', (req, res) => {
    const docxPath = path.join(SALIDA_DIR, 'Carnets_Torneo.docx');
    if (fs.existsSync(docxPath)) {
        res.download(docxPath, 'Carnets_Torneo.docx');
    } else {
        res.status(404).send('Archivo Word no encontrado.');
    }
});

app.get('/api/descargar/pdf', (req, res) => {
    const pdfPath = path.join(SALIDA_DIR, 'Carnets_Torneo.pdf');
    if (fs.existsSync(pdfPath)) {
        res.download(pdfPath, 'Carnets_Torneo.pdf');
    } else {
        res.status(404).send('Archivo PDF no encontrado.');
    }
});

// 8. Abrir en Windows
app.post('/api/abrir', (req, res) => {
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

app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` Servidor de Carnets iniciado en: http://localhost:${PORT}`);
    console.log(` Carpeta de fotos: ${FOTOS_DIR}`);
    console.log(` Carpeta de salida: ${SALIDA_DIR}`);
    console.log(`=======================================================`);
});
