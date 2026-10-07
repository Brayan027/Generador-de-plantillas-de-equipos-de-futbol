'use strict';
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { execSync } = require('child_process');

/**
 * Convierte texto a formato con primera letra en mayúscula (Title Case).
 */
function toTitleCase(str, isTeam = false) {
    if (!str) return '';
    const acronyms = ['FC', 'CD', 'CF', 'AD', 'SC', 'CSD', 'U', 'SD', 'FK'];
    return str.trim().split(/\s+/).map(w => {
        const upper = w.toUpperCase();
        if (isTeam && acronyms.includes(upper)) return upper;
        const lower = w.toLowerCase();
        return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join(' ');
}

/**
 * Extrae y normaliza el equipo y nombre a partir del nombre de archivo.
 */
function parseFilename(filename) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext).trim();
    let rawEquipo = 'Sin Equipo', rawNombre = base;
    if (base.includes(' - ')) {
        const parts = base.split(' - ');
        rawEquipo = parts[0].trim();
        rawNombre = parts.slice(1).join(' - ').trim();
    } else if (base.includes('-')) {
        const parts = base.split('-');
        rawEquipo = parts[0].trim();
        rawNombre = parts.slice(1).join('-').trim();
    } else if (base.includes('_')) {
        const parts = base.split('_');
        rawEquipo = parts[0].trim();
        rawNombre = parts.slice(1).join('_').trim();
    }
    return {
        equipo: toTitleCase(rawEquipo, true),
        nombre: toTitleCase(rawNombre, false)
    };
}

function escapeXml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Genera el XML del cuadro de texto con los datos del jugador (EQUIPO y NOMBRE).
 */
function buildDataBoxTxbx(equipo, nombre) {
    const rprBold = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:color w:val="000000" w:themeColor="text1"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="es-ES"/>';
    const rprNorm = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:color w:val="000000" w:themeColor="text1"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="es-ES"/>';

    return `<w:txbxContent>`
        + `<w:p><w:pPr><w:rPr>${rprBold}</w:rPr></w:pPr>`
        + `<w:r><w:rPr>${rprBold}</w:rPr><w:t xml:space="preserve">EQUIPO: </w:t></w:r>`
        + `<w:r><w:rPr>${rprBold}</w:rPr><w:t>${escapeXml(equipo)}</w:t></w:r></w:p>`
        + `<w:p><w:pPr><w:rPr>${rprNorm}</w:rPr></w:pPr></w:p>`
        + `<w:p><w:pPr><w:rPr>${rprBold}</w:rPr></w:pPr>`
        + `<w:r><w:rPr>${rprBold}</w:rPr><w:t>NOMBRE:</w:t></w:r></w:p>`
        + `<w:p><w:pPr><w:rPr>${rprNorm}</w:rPr></w:pPr>`
        + `<w:r><w:rPr>${rprNorm}</w:rPr><w:t>${escapeXml(nombre)}</w:t></w:r></w:p>`
        + `</w:txbxContent>`;
}

function clearDataBoxTxbx() {
    return `<w:txbxContent><w:p><w:r><w:t></w:t></w:r></w:p></w:txbxContent>`;
}

/**
 * Limpia y preprocesa automáticamente fotos problemáticas:
 * 1. Respeta rotación EXIF natural (.rotate()).
 * 2. Si la foto es una foto física tomada sobre una mesa/superficie oscura, recorta automáticamente el recuadro del carnet.
 * 3. Si la foto es una captura de pantalla (con franjas negras arriba/abajo, hora, batería, etc.), las recorta automáticamente.
 */
async function autoPreprocessPhoto(rawBuffer) {
    if (!rawBuffer) return rawBuffer;
    try {
        let image = sharp(rawBuffer).rotate();
        const meta = await image.metadata();
        const w = meta.width;
        const h = meta.height;
        if (!w || !h || w < 20 || h < 20) return rawBuffer;

        const sampleW = 200;
        const sampleH = Math.round((h / w) * sampleW);
        const { data } = await image.clone().resize(sampleW, sampleH).raw().toBuffer({ resolveWithObject: true });

        const getLum = (x, y) => {
            const idx = (y * sampleW + x) * meta.channels;
            return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        };

        // 1. Detectar si es una foto física tomada sobre una mesa o fondo oscuro
        let darkBorderCount = 0;
        let totalBorderSamples = 0;
        for (let x = 0; x < sampleW; x += 4) {
            totalBorderSamples += 2;
            if (getLum(x, 2) < 60) darkBorderCount++;
            if (getLum(x, sampleH - 3) < 60) darkBorderCount++;
        }
        for (let y = 0; y < sampleH; y += 4) {
            totalBorderSamples += 2;
            if (getLum(2, y) < 60) darkBorderCount++;
            if (getLum(sampleW - 3, y) < 60) darkBorderCount++;
        }

        const isDarkSurround = (darkBorderCount / totalBorderSamples) > 0.85;
        if (isDarkSurround) {
            let minX = sampleW, maxX = 0, minY = sampleH, maxY = 0;
            for (let y = Math.floor(sampleH * 0.08); y < Math.floor(sampleH * 0.92); y++) {
                for (let x = Math.floor(sampleW * 0.08); x < Math.floor(sampleW * 0.92); x++) {
                    if (getLum(x, y) > 130) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            const cardW = maxX - minX;
            const cardH = maxY - minY;
            if (cardW > sampleW * 0.15 && cardH > sampleH * 0.15 && cardW < sampleW * 0.88 && cardH < sampleH * 0.88) {
                const scaleX = w / sampleW;
                const scaleY = h / sampleH;
                const extractLeft = Math.max(0, Math.floor(minX * scaleX));
                const extractTop = Math.max(0, Math.floor(minY * scaleY));
                const extractWidth = Math.min(w - extractLeft, Math.ceil(cardW * scaleX));
                const extractHeight = Math.min(h - extractTop, Math.ceil(cardH * scaleY));
                return await image.extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight }).toBuffer();
            }
        }

        // 2. Detectar barras negras de capturas de pantalla móviles (arriba y/o abajo)
        let topBarEnd = 0;
        for (let y = 0; y < Math.floor(sampleH * 0.35); y++) {
            let darkPixels = 0;
            for (let x = 0; x < sampleW; x++) {
                if (getLum(x, y) < 45) darkPixels++;
            }
            if (darkPixels / sampleW > 0.78) {
                topBarEnd = y;
            } else if (y > 4 && (darkPixels / sampleW) < 0.5) {
                break;
            }
        }

        let bottomBarStart = sampleH - 1;
        for (let y = sampleH - 1; y >= Math.floor(sampleH * 0.65); y--) {
            let darkPixels = 0;
            for (let x = 0; x < sampleW; x++) {
                if (getLum(x, y) < 45) darkPixels++;
            }
            if (darkPixels / sampleW > 0.78) {
                bottomBarStart = y;
            } else if ((sampleH - 1 - y) > 4 && (darkPixels / sampleW) < 0.5) {
                break;
            }
        }

        const hasTopBar = topBarEnd > sampleH * 0.04;
        const hasBottomBar = (sampleH - 1 - bottomBarStart) > sampleH * 0.04;

        if (hasTopBar || hasBottomBar) {
            const scaleY = h / sampleH;
            const cropTop = hasTopBar ? Math.min(h - 50, Math.ceil((topBarEnd + 1) * scaleY)) : 0;
            const cropBottom = hasBottomBar ? Math.max(cropTop + 50, Math.floor(bottomBarStart * scaleY)) : h;
            const cropHeight = cropBottom - cropTop;

            if (cropHeight > 100) {
                return await image.extract({ left: 0, top: cropTop, width: w, height: cropHeight }).toBuffer();
            }
        }

        return await image.toBuffer();
    } catch (e) {
        return rawBuffer;
    }
}

/**
 * Genera el documento Word (.docx) y PDF (.pdf) inyectando los datos
 * de los jugadores directamente sobre la plantilla original.
 */
async function generarCarnets(opciones = {}) {
    const baseDir = opciones.baseDir || __dirname;
    const templatePath = path.join(baseDir, 'plantilla origina.docx');
    const fotosDir = opciones.fotosDir || path.join(baseDir, 'fotos_jugadores');
    const salidaDir = opciones.salidaDir || path.join(baseDir, 'salida');

    if (!fs.existsSync(salidaDir)) fs.mkdirSync(salidaDir, { recursive: true });
    if (!fs.existsSync(templatePath)) {
        throw new Error(`No se encontró la plantilla original en: ${templatePath}`);
    }

    const templateBuf = fs.readFileSync(templatePath);
    const zip = await JSZip.loadAsync(templateBuf);
    let docXml = await zip.file('word/document.xml').async('string');
    let relsXml = await zip.file('word/_rels/document.xml.rels').async('string');

    // Registrar .jpg y .jpeg en [Content_Types].xml para evitar errores de validación en Word
    let ctXml = await zip.file('[Content_Types].xml').async('string');
    if (!ctXml.includes('Extension="jpg"')) {
        ctXml = ctXml.replace('</Types>', '<Default Extension="jpg" ContentType="image/jpeg"/></Types>');
    }
    if (!ctXml.includes('Extension="jpeg"')) {
        ctXml = ctXml.replace('</Types>', '<Default Extension="jpeg" ContentType="image/jpeg"/></Types>');
    }
    zip.file('[Content_Types].xml', ctXml);

    // Obtener lista de jugadores
    let listaJugadores = opciones.jugadores;
    if (!listaJugadores || listaJugadores.length === 0) {
        if (!fs.existsSync(fotosDir)) fs.mkdirSync(fotosDir, { recursive: true });
        const files = fs.readdirSync(fotosDir).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
        if (files.length === 0) {
            return {
                success: false,
                message: `No se encontraron fotos en: ${fotosDir}. Guarda fotos como 'Equipo - Nombre.jpg'`
            };
        }
        listaJugadores = files.map(file => {
            const parsed = parseFilename(file);
            return {
                filename: file,
                filePath: path.join(fotosDir, file),
                equipo: parsed.equipo,
                nombre: parsed.nombre
            };
        });
    }

    console.log(`Procesando ${listaJugadores.length} jugadores...`);

    // Normalizar datos de jugadores
    const players = listaJugadores.map(j => {
        return {
            filename: j.filename || '',
            filePath: j.filePath || (j.filename ? path.join(fotosDir, j.filename) : ''),
            buffer: j.buffer || null,
            equipo: toTitleCase(j.equipo || 'Sin Equipo', true),
            nombre: toTitleCase(j.nombre || 'Sin Nombre', false)
        };
    });

    // Ordenar jugadores agrupados por equipo y luego por nombre
    players.sort((a, b) => {
        const compEq = a.equipo.localeCompare(b.equipo, 'es', { sensitivity: 'base' });
        if (compEq !== 0) return compEq;
        return a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' });
    });

    // Extraer la tabla original de la plantilla
    const tblMatch = docXml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>/);
    if (!tblMatch) throw new Error('No se encontró la tabla de carnets en la plantilla original');
    const originalTblXml = tblMatch[0];

    // Asegurar que [Content_Types].xml soporte jpeg y png
    let contentTypesXml = await zip.file('[Content_Types].xml').async('text');
    if (!contentTypesXml.includes('Extension="jpeg"') || !contentTypesXml.includes('Extension="jpg"')) {
        contentTypesXml = contentTypesXml.replace('</Types>', '<Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="jpg" ContentType="image/jpeg"/></Types>');
        zip.file('[Content_Types].xml', contentTypesXml);
    }

    // Pre-procesar todas las fotos en paralelo para máxima velocidad (de 35s a 2s)
    console.log(`Optimizando y procesando fotos de ${players.length} jugadores en paralelo...`);
    const processedPhotosMap = new Map();
    const BATCH_SIZE = 8;
    for (let i = 0; i < players.length; i += BATCH_SIZE) {
        const batch = players.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (player) => {
            const key = player.filename || player.filePath;
            let rawPhoto = player.buffer;
            if (!rawPhoto && player.filePath && fs.existsSync(player.filePath)) {
                try { rawPhoto = fs.readFileSync(player.filePath); } catch (_) {}
            }
            if (!rawPhoto) return;

            try {
                // Rotar según orientación EXIF y redimensionar inteligentemente
                let resized = await sharp(rawPhoto)
                    .rotate()
                    .resize(600, 660, { fit: 'cover', position: sharp.strategy.attention, kernel: 'lanczos3' })
                    .jpeg({ quality: 86, mozjpeg: false })
                    .toBuffer();
                processedPhotosMap.set(key, resized);
            } catch (err) {
                try {
                    let resized = await sharp(rawPhoto)
                        .rotate()
                        .resize(600, 660, { fit: 'cover', position: 'center' })
                        .jpeg({ quality: 86 })
                        .toBuffer();
                    processedPhotosMap.set(key, resized);
                } catch (e2) {
                    console.warn(`Aviso al procesar foto de ${player.nombre}:`, e2.message);
                }
            }
        }));
    }

    // Dividir en páginas de 12 carnets (cuadrícula 3x4)
    const CARDS_PER_PAGE = 12;
    const pages = [];
    for (let i = 0; i < players.length; i += CARDS_PER_PAGE) {
        pages.push(players.slice(i, i + CARDS_PER_PAGE));
    }

    const generatedTables = [];

    for (let pIdx = 0; pIdx < pages.length; pIdx++) {
        const pagePlayers = pages[pIdx];
        let tblXml = originalTblXml;

        // Si es una página adicional (>0), hacer únicos los IDs de formas para que Word no colisione
        if (pIdx > 0) {
            const offset = pIdx * 10000;
            tblXml = tblXml.replace(/(<wp:docPr\s+id=")(\d+)(")/g, (m, pre, id, post) => `${pre}${parseInt(id) + offset}${post}`);
            tblXml = tblXml.replace(/(anchorId=")([0-9A-Fa-f]{8})(")/g, (m, pre, id, post) => `${pre}${(parseInt(id, 16) + offset).toString(16).toUpperCase().padStart(8, '0')}${post}`);
            tblXml = tblXml.replace(/(editId=")([0-9A-Fa-f]{8})(")/g, (m, pre, id, post) => `${pre}${(parseInt(id, 16) + offset).toString(16).toUpperCase().padStart(8, '0')}${post}`);
        }

        // Encontrar límites de cada celda <w:tc> en la tabla
        const cellBounds = [];
        let pos = 0;
        while (true) {
            const s = tblXml.indexOf('<w:tc>', pos);
            if (s === -1) break;
            const e = tblXml.indexOf('</w:tc>', s) + '</w:tc>'.length;
            cellBounds.push({ s, e });
            pos = e;
        }

        // Modificar celdas en orden inverso para no alterar offsets
        for (let c = cellBounds.length - 1; c >= 0; c--) {
            const { s, e } = cellBounds[c];
            let cell = tblXml.slice(s, e);
            const player = pagePlayers[c];

            if (player) {
                const rId = `rIdCardPhotoP${pIdx}C${c}`;
                const photoFilename = `photo_p${pIdx}_c${c}.jpeg`;
                const key = player.filename || player.filePath;
                const resized = processedPhotosMap.get(key);

                if (resized) {
                    zip.file(`word/media/${photoFilename}`, resized);
                    relsXml = relsXml.replace(
                        '</Relationships>',
                        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${photoFilename}"/></Relationships>`
                    );

                    // Reemplazar foto placeholder solidFill por la foto real blipFill
                    const photoMarker = 'cx="1043305"';
                    const pPos = cell.indexOf(photoMarker);
                    if (pPos !== -1) {
                        const fillMarker = '<a:solidFill><a:schemeClr val="bg1"/></a:solidFill>';
                        const fillIdx = cell.indexOf(fillMarker, pPos);
                        if (fillIdx !== -1) {
                            const blipFill = `<a:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>`;
                            cell = cell.slice(0, fillIdx) + blipFill + cell.slice(fillIdx + fillMarker.length);
                        }
                    }
                }

                // Inyectar datos del jugador (EQUIPO y NOMBRE)
                const dataMarker = 'cx="1781370"';
                const dPos = cell.indexOf(dataMarker);
                if (dPos !== -1) {
                    const txOpen = '<w:txbxContent>';
                    const txClose = '</w:txbxContent>';
                    const txStart = cell.indexOf(txOpen, dPos);
                    if (txStart !== -1) {
                        const txEnd = cell.indexOf(txClose, txStart) + txClose.length;
                        cell = cell.slice(0, txStart) + buildDataBoxTxbx(player.equipo, player.nombre) + cell.slice(txEnd);
                    }
                }
            } else {
                // Celda vacía sin jugador: limpiar el cuadro de texto placeholder
                const dataMarker = 'cx="1781370"';
                const dPos = cell.indexOf(dataMarker);
                if (dPos !== -1) {
                    const txOpen = '<w:txbxContent>';
                    const txClose = '</w:txbxContent>';
                    const txStart = cell.indexOf(txOpen, dPos);
                    if (txStart !== -1) {
                        const txEnd = cell.indexOf(txClose, txStart) + txClose.length;
                        cell = cell.slice(0, txStart) + clearDataBoxTxbx() + cell.slice(txEnd);
                    }
                }
            }

            tblXml = tblXml.slice(0, s) + cell + tblXml.slice(e);
        }

        generatedTables.push(tblXml);
    }

    // Unir tablas con salto de página explícito de altura cero entre cada una
    const pageBreak = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>';
    const allTablesXml = generatedTables.join(pageBreak);

    // Reemplazar la tabla en document.xml
    docXml = docXml.replace(originalTblXml, allTablesXml);

    zip.file('word/document.xml', docXml);
    zip.file('word/_rels/document.xml.rels', relsXml);

    const docxBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const docxPath = opciones.salidaDocx || path.join(salidaDir, 'Carnets_Torneo.docx');
    const pdfPath = opciones.salidaPdf || path.join(salidaDir, 'Carnets_Torneo.pdf');

    fs.writeFileSync(docxPath, docxBuf);
    console.log(`Documento Word generado usando plantilla original: ${docxPath}`);

    // Generar documento PDF oficial de forma nativa (compatible 100% con Windows y Linux Alwaysdata)
    try {
        const { generarCarnetsPdf } = require('./generador_pdf.js');
        await generarCarnetsPdf({
            salidaPdf: pdfPath,
            bannerPath: bannerPath || path.join(baseDir, 'banner.png'),
            jugadores: players,
            fotosDir
        });
        console.log(`Documento PDF generado exitosamente: ${pdfPath}`);
    } catch (errPdf) {
        console.warn("Aviso al generar PDF nativo:", errPdf.message);
        if (process.platform === 'win32') {
            try {
                const psScript = path.join(baseDir, 'convert.ps1');
                execSync(`powershell -ExecutionPolicy Bypass -File "${psScript}" -DocxPath "${docxPath}" -PdfPath "${pdfPath}"`, {
                    stdio: 'ignore',
                    timeout: 8000,
                    windowsHide: true
                });
                console.log(`Documento PDF generado con Word COM: ${pdfPath}`);
            } catch (e) {
                console.warn("Aviso al convertir con Word COM:", e.message);
            }
        }
    }

    return {
        success: true,
        totalJugadores: players.length,
        totalPaginas: pages.length,
        docxPath,
        pdfPath
    };
}

module.exports = {
    generarCarnets,
    parseFilename,
    toTitleCase,
    autoPreprocessPhoto
};

if (require.main === module) {
    generarCarnets()
        .then(res => console.log('\nResultado:', res))
        .catch(console.error);
}
