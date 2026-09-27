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

    // Extraer la tabla original de la plantilla
    const tblMatch = docXml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>/);
    if (!tblMatch) throw new Error('No se encontró la tabla de carnets en la plantilla original');
    const originalTblXml = tblMatch[0];

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

                // Cargar imagen
                let rawPhoto = player.buffer;
                if (!rawPhoto && player.filePath && fs.existsSync(player.filePath)) {
                    rawPhoto = fs.readFileSync(player.filePath);
                }

                if (rawPhoto) {
                    // Procesar a alta resolución Full HD (800x880) con interpolación Lanczos3 y nitidez optimizada
                    const resized = await sharp(rawPhoto)
                        .resize(800, 880, { fit: 'cover', position: 'center', kernel: 'lanczos3' })
                        .sharpen({ sigma: 1.0, m1: 0.6, m2: 2.0 })
                        .png({ quality: 100, compressionLevel: 6 })
                        .toBuffer();

                    const photoFilename = `photo_p${pIdx}_c${c}.png`;
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

    // Exportar a PDF usando Word COM
    try {
        const psScript = path.join(baseDir, 'convert.ps1');
        execSync(`powershell -ExecutionPolicy Bypass -File "${psScript}" -DocxPath "${docxPath}" -PdfPath "${pdfPath}"`, {
            stdio: 'inherit'
        });
        console.log(`Documento PDF generado en horizontal: ${pdfPath}`);
    } catch (e) {
        console.warn("Aviso al convertir a PDF:", e.message);
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
    toTitleCase
};

if (require.main === module) {
    generarCarnets()
        .then(res => console.log('\nResultado:', res))
        .catch(console.error);
}
