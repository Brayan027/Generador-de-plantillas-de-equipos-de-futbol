# ⚽ Generador Automatizado de Plantillas y Carnets Deportivos

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg?logo=node.js)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express-5.x-lightgrey.svg?logo=express)](https://expressjs.com/)
[![Sharp](https://img.shields.io/badge/Sharp-Image%20Processing-blue.svg?logo=sharp)](https://sharp.pixelplumbing.com/)
[![OpenXML](https://img.shields.io/badge/OpenXML-JSZip-orange.svg)](https://en.wikipedia.org/wiki/Office_Open_XML)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Sistema integral de automatización para la generación por lotes de credenciales, planillas y carnets deportivos de fútbol. El sistema procesa fotografías de jugadores, estandariza la tipografía y los datos del club, y genera documentos finales en formatos **Microsoft Word (.docx)** y **PDF (.pdf)** preservando una cuadrícula fija de alta fidelidad (12 carnets por página horizontal, 3 columnas × 4 filas).

---

## 📌 Tabla de Contenidos

- [Descripción General](#-descripción-general)
- [Arquitectura y Funcionamiento Técnico](#-arquitectura-y-funcionamiento-técnico)
- [Características Principales](#-características-principales)
- [Estructura del Proyecto](#-estructura-del-proyecto)
- [Requisitos del Entorno](#-requisitos-del-entorno)
- [Instalación y Configuración](#-instalación-y-configuración)
- [Modos de Ejecución](#-modos-de-ejecución)
  - [Opción 1: Modo Directo por Lotes (1 Clic)](#opción-1-modo-directo-por-lotes-1-clic)
  - [Opción 2: Panel Web Interactivo](#opción-2-panel-web-interactivo)
- [Convención de Nomenclatura](#-convención-de-nomenclatura)
- [Licencia](#-licencia)

---

## 📖 Descripción General

En la administración de torneos deportivos amateur y profesionales, el recorte manual de fotografías, la alineación en procesadores de texto y el ajuste celda por celda suele provocar descuadres en la maquetación. 

Este proyecto resuelve este problema a través de un motor que automatiza la ingesta de fotos, la extracción semántica de datos (Nombre del Club y Nombre del Jugador), el reescalado y recorte proporcional de imágenes, y la inyección binaria directa sobre el estándar **Office Open XML (OOXML / WordprocessingML)** de una plantilla base.

---

## ⚙️ Arquitectura y Funcionamiento Técnico

El flujo de procesamiento técnico interno se compone de las siguientes etapas:

```
[ Fotos (WhatsApp/Disco) ]
           │
           ▼
[ Parseo Semántico & Title Case ] ──> Normalización de acrónimos (FC, CF, CD...)
           │
           ▼
[ Pipeline Sharp (Procesamiento Gráfico) ] ──> Normalización a 230x290px, 96 DPI, PNG
           │
           ▼
[ Motor OpenXML (JSZip) ] ──────────> Descompresión de .docx base
           │                           ├─ Manipulación directa de document.xml
           │                           ├─ Creación de relaciones rId en document.xml.rels
           │                           └─ Inyección de buffers en word/media/
           ▼
[ Ensamblado Multi-página ] ────────> Paginación continua (12 carnets por sección / hoja Letter horizontal)
           │
           ▼
[ Exportación Word (.docx) ]
           │
           ▼
[ Puente PowerShell COM ] ──────────> Automatización COM (Word.Application) -> ExportAsFixedFormat
           │
           ▼
[ PDF Listo para Imprimir (.pdf) ]
```

### 1. Ingesta y Análisis Léxico
El módulo [`generador.js`](generador.js) implementa la función `parseFilename()`, que descompone cadenas como `Equipo - Nombre del Jugador.ext` mediante expresiones regulares y separadores comunes (`-`, `_`). 
Aplica un algoritmo de conversión a **Title Case** respetando acrónimos deportivos específicos (`FC`, `CD`, `CF`, `AD`, `SC`, `CSD`, `FK`, etc.) para evitar minúsculas erróneas como `"Fc"`.

### 2. Procesamiento de Imágenes con Sharp
Cada fotografía subida o leída de disco pasa por el pipeline de [`sharp`](https://sharp.pixelplumbing.com/):
- Estandarización de tamaño al marco del carnet: **230 × 290 px**.
- Ajuste proporcional (`fit: 'cover'`, `position: 'center'`).
- Conversión a búfer PNG en memoria sin escrituras intermedias lentas en disco.

### 3. Manipulación de Office Open XML (WordprocessingML)
En lugar de depender de renderizadores de terceros que alteran la geometría del documento:
- Se utiliza [`jszip`](https://stuk.github.io/jszip/) para descomprimir la plantilla base [`plantilla origina.docx`](plantilla%20origina.docx).
- Se extrae e inspecciona `word/document.xml` y `word/_rels/document.xml.rels`.
- Se reemplazan o agregan los elementos `<w:txbxContent>` (cuadros de texto con tipografía Arial, tamaño estandarizado y espaciado exacto).
- Se inyectan las imágenes optimizadas dentro de `word/media/` con sus correspondientes identificadores de relación (`rId`).
- Si la cantidad de jugadores supera 12, el motor genera páginas adicionales manteniendo las dimensiones de sección horizontal (Letter landscape: `15840 × 12240` dxa).

### 4. Conversión Nativa a PDF mediante Interoperabilidad COM
A través de [`convert.ps1`](convert.ps1), Node.js invoca un proceso PowerShell que instancia el motor COM de Microsoft Word (`Word.Application`). El documento se abre en modo silencioso y se compila a PDF con `ExportAsFixedFormat` (wdExportFormatPDF = 17), garantizando una fidelidad tipográfica y de márgenes del 100%.

---

## ✨ Características Principales

- **Fidelidad Absoluta de Diseño**: Mantiene los encabezados oficiales, logotipos de torneo y dimensiones milimétricas del carnet original.
- **Cuadrícula Fija 3×4**: Hasta 12 carnets organizados simétricamente por página horizontal.
- **Doble Interfaz de Usuario**:
  - **Línea de Comandos / Lote**: Procesamiento inmediato con un solo clic para usuarios que no desean abrir navegadores.
  - **Panel Web Moderno**: Interfaz gráfica en Express con previsualización tipo *Live Print Preview*, subida múltiple por arrastrar y soltar (*drag and drop*) y edición en línea de nombres/equipos.
- **Generación Simultánea**: Produce tanto el archivo Word editable (`.docx`) como el PDF final listo para enviar a imprenta.
- **Seguridad en Entrada**: Escapado automático de caracteres reservados XML (`&`, `<`, `>`, `"`) para prevenir corrupción del estándar OpenXML.

---

## 📁 Estructura del Proyecto

```text
├── fotos_jugadores/           # Directorio de entrada para fotografías de jugadores
├── public/                    # Frontend estático del panel web
│   └── index.html             # Interfaz web con previsualización en vivo
├── salida/                    # Directorio de salida (archivos generados .docx y .pdf)
├── ABRIR_PANEL_WEB.bat        # Acceso directo para levantar el servidor y abrir el panel
├── GENERAR_CARNETS_DIRECTO.bat# Script de ejecución por lotes inmediata en 1 clic
├── INSTRUCCIONES.txt          # Guía rápida para usuarios finales
├── banner.png                 # Encabezado institucional del carnet
├── convert.ps1                # Script PowerShell para exportación nativa Word -> PDF
├── generador.js               # Motor principal de procesamiento OpenXML y Sharp
├── server.js                  # Servidor Express, API REST y gestión de subidas Multer
├── plantilla origina.docx     # Plantilla base en formato WordprocessingML
├── package.json               # Manifiesto de dependencias del proyecto
├── .gitignore                 # Exclusión de node_modules y archivos generados
└── LICENSE                    # Licencia de código abierto MIT
```

---

## 💻 Requisitos del Entorno

1. **Sistema Operativo**: Windows 10 / Windows 11 (requerido para la conversión COM a PDF vía PowerShell y Microsoft Word).
2. **Node.js**: Versión 16.x o superior ([Descargar Node.js](https://nodejs.org/)).
3. **Microsoft Word**: Instalado en el sistema (necesario para compilar el PDF de alta fidelidad).

---

## 🚀 Instalación y Configuración

1. **Clonar el repositorio**:
   ```bash
   git clone https://github.com/Brayan027/Generador-de-plantillas-de-equipos-de-futbol.git
   cd Generador-de-plantillas-de-equipos-de-futbol
   ```

2. **Instalar dependencias**:
   ```bash
   npm install
   ```

---

## 🖥️ Modos de Ejecución

### Opción 1: Modo Directo por Lotes (1 Clic)
Ideal cuando tienes una carpeta con las fotos ya descargadas y organizadas:
1. Copia las fotos a la carpeta `fotos_jugadores/`.
2. Ejecuta haciendo doble clic en:
   ```cmd
   GENERAR_CARNETS_DIRECTO.bat
   ```
3. El proceso procesará las imágenes, compilará el archivo `.docx` y el `.pdf` en la carpeta `salida/`, y abrirá el PDF generado automáticamente en tu lector predeterminado.

---

### Opción 2: Panel Web Interactivo
Ideal para revisar visualmente la distribución antes de generar:
1. Ejecuta haciendo doble clic en:
   ```cmd
   ABRIR_PANEL_WEB.bat
   ```
   *(o inicia manualmente con `node server.js` y navega a `http://localhost:3000`)*.
2. Desde el panel podrás:
   - Arrastrar y soltar fotos directamente desde WhatsApp o el explorador de archivos.
   - Editar nombres de jugadores y clubes en tiempo real.
   - Observar la maquetación en la hoja horizontal tamaño carta.
   - Hacer clic en **"Generar Word & PDF"**.

---

## 🏷️ Convención de Nomenclatura

Para que el analizador léxico asigne automáticamente el equipo y nombre sin intervención manual, nombra los archivos con el siguiente estándar:

```text
Nombre del Club - Nombre Completo del Jugador.jpg
```

**Ejemplos válidos:**
- `Elite FC - Gabriel Antonio Gonzalez Garcia.png`
- `Cobradores - Jose Gonzalez.jpeg`
- `Titanes FC - Wilmer Enrique Mejia Mendez.jpg`

El separador ` - ` divide el nombre de la institución del nombre del futbolista.

---

## 📄 Licencia

Este proyecto está bajo la Licencia **MIT**. Consulta el archivo [LICENSE](LICENSE) para más información.
