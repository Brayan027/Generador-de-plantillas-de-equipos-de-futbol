const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

/**
 * Genera el documento PDF oficial de carnets (Letter Horizontal, 12 por página en cuadrícula 3x4).
 * Funciona de manera 100% nativa en Windows y Linux (Alwaysdata) sin dependencias externas.
 */
async function generarCarnetsPdf({ salidaPdf, bannerPath, jugadores, fotosDir }) {
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: [792, 612], // Letter Landscape (11 x 8.5 in)
                margins: { top: 8.5, bottom: 8.5, left: 8.5, right: 8.5 },
                autoFirstPage: false,
                info: {
                    Title: 'Planilla Oficial de Carnets - Torneo San Antonio',
                    Author: 'Sistema Torneo San Antonio'
                }
            });

            const stream = fs.createWriteStream(salidaPdf);
            doc.pipe(stream);

            // Pre-cargar banner
            let bannerPng = null;
            if (fs.existsSync(bannerPath)) {
                bannerPng = await sharp(bannerPath)
                    .resize(500, 60, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
                    .png()
                    .toBuffer();
            }

            // Dimensiones de cuadrícula
            const originX = 14;
            const originY = 12;
            const cardW = 246;
            const cardH = 138;
            const cols = 3;
            const rows = 4;
            const CARDS_PER_PAGE = 12;

            // Dividir jugadores en páginas de 12
            const totalPaginas = Math.ceil(jugadores.length / CARDS_PER_PAGE);

            for (let p = 0; p < totalPaginas; p++) {
                doc.addPage();
                const pagePlayers = jugadores.slice(p * CARDS_PER_PAGE, (p + 1) * CARDS_PER_PAGE);

                for (let i = 0; i < pagePlayers.length; i++) {
                    const player = pagePlayers[i];
                    const c = i % cols;
                    const r = Math.floor(i / cols);
                    const x = originX + c * (cardW + 8);
                    const y = originY + r * (cardH + 8);

                    // Borde exterior del carnet
                    doc.roundedRect(x, y, cardW, cardH, 4)
                       .lineWidth(1)
                       .strokeColor('#cbd5e1')
                       .stroke();

                    // Banner superior
                    if (bannerPng) {
                        doc.image(bannerPng, x + 6, y + 5, { width: cardW - 12, height: 26 });
                    }

                    // Línea divisoria verde
                    doc.moveTo(x + 6, y + 33)
                       .lineTo(x + cardW - 6, y + 33)
                       .lineWidth(1.5)
                       .strokeColor('#10b981')
                       .stroke();

                    // Foto del jugador
                    let photoBuf = player.buffer;
                    if (!photoBuf && player.filePath && fs.existsSync(player.filePath)) {
                        photoBuf = fs.readFileSync(player.filePath);
                    }

                    const pX = x + 8;
                    const pY = y + 38;
                    const pW = 75;
                    const pH = 90;

                    if (photoBuf) {
                        try {
                            const clean = await sharp(photoBuf)
                                .rotate()
                                .resize(225, 270, { fit: 'cover', position: sharp.strategy.attention })
                                .jpeg({ quality: 90 })
                                .toBuffer();

                            doc.roundedRect(pX, pY, pW, pH, 3)
                               .lineWidth(1)
                               .strokeColor('#10b981')
                               .stroke();

                            doc.image(clean, pX + 1, pY + 1, { width: pW - 2, height: pH - 2 });
                        } catch (err) {
                            doc.roundedRect(pX, pY, pW, pH, 3).strokeColor('#cbd5e1').stroke();
                        }
                    } else {
                        doc.roundedRect(pX, pY, pW, pH, 3).strokeColor('#cbd5e1').stroke();
                    }

                    // Textos
                    const tX = pX + pW + 8;
                    const tY = y + 42;
                    const tW = cardW - (pW + 24);

                    // Equipo
                    doc.fillColor('#000000')
                       .font('Helvetica-Bold')
                       .fontSize(7.5)
                       .text('EQUIPO:', tX, tY, { width: tW });

                    doc.fillColor('#047857')
                       .font('Helvetica-Bold')
                       .fontSize(9.5)
                       .text((player.equipo || 'Sin Equipo').toUpperCase(), tX, tY + 10, { width: tW, lineBreak: true });

                    // Nombre
                    doc.fillColor('#000000')
                       .font('Helvetica-Bold')
                       .fontSize(7.5)
                       .text('NOMBRE:', tX, tY + 46, { width: tW });

                    doc.fillColor('#0f172a')
                       .font('Helvetica-Bold')
                       .fontSize(10)
                       .text((player.nombre || 'Sin Nombre').toUpperCase(), tX, tY + 57, { width: tW, lineBreak: true });
                }
            }

            doc.end();

            stream.on('finish', () => {
                resolve({ success: true, pdfPath: salidaPdf, totalPaginas });
            });
            stream.on('error', reject);
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { generarCarnetsPdf };
