# Guía para Subir el Proyecto a Alwaysdata

Tu proyecto ya está 100% configurado para funcionar en **Alwaysdata** sin necesidad de tocar código ni archivos adicionales.

---

## 🔐 Datos de Acceso
- **Portal Público (Carnets, Consulta y Registro):** Disponible en la raíz `/` de tu dominio (ejemplo: `https://tu-sitio.alwaysdata.net/`).
- **Panel de Administración:** `https://tu-sitio.alwaysdata.net/admin`
- **Contraseña de Administrador:** `SUPERV1S0R`

---

## 🚀 Pasos para Subir y Ejecutar en Alwaysdata

### 1. Subir los Archivos a Alwaysdata
Puedes subir los archivos a tu cuenta de Alwaysdata mediante **FTP / SFTP**, SSH o extrayendo un archivo ZIP en el Administrador de Archivos de Alwaysdata:
- Sube todos los archivos del proyecto a tu carpeta de sitio, por ejemplo:
  `/home/tu_usuario/tu_sitio/`

> **Nota importante:**
> No es necesario que subas la carpeta `node_modules` (es mejor instalarla en el servidor para que sea compatible con Linux) ni necesitas subir todas las fotos manualmente si ya están en la base de datos MySQL (el servidor las sincronizará automáticamente).

### 2. Configurar el Sitio en el Panel de Alwaysdata
1. Entra a tu panel de Alwaysdata: **Web** > **Sites**.
2. Haz clic en **Add a site** (o edita el que ya tienes):
   - **Name:** Elige el nombre o subdominio deseado.
   - **Type:** Selecciona **Node.js**.
   - **Node.js version:** Versión 18, 20 o 22 (recomendado 20.x o superior).
   - **Working directory:** La ruta donde subiste tus archivos (ej. `/home/tu_usuario/tu_sitio`).
   - **Command:** Deja el comando por defecto o escribe:
     ```bash
     npm start
     ```
     *(También funciona `node server.js`)*.
3. Guarda los cambios (**Submit**).

### 3. Instalar Dependencias (Vía SSH o Consola de Alwaysdata)
En la consola SSH de Alwaysdata (o en **Web** > **Sites** > botón consola), dentro de la carpeta del proyecto ejecuta:
```bash
npm install
```

### 4. ¡Listo! Tu Sitio Estará Activo
- La conexión con tu base de datos de Alwaysdata (`mysql-doct.alwaysdata.net`) ya está integrada por defecto.
- Al iniciar, el servidor detecta automáticamente el puerto y la IP asignados por Alwaysdata.
- Si las fotos ya estaban guardadas en la base de datos MySQL, el servidor las restaura automáticamente en la carpeta de fotos al arrancar.

---

## 📋 Resumen de Lo Que Hace el Sistema

1. **Público (Para Jugadores y Consulta):**
   - Búsqueda en vivo de jugadores por nombre completo.
   - Registro con cámara selfie o subiendo foto desde la galería.
   - Visualización del carnet oficial habilitado para el torneo.
   - **Descarga directa del carnet en alta resolución (formato imagen PNG)** directamente al celular o computadora.
   - Se eliminó el código QR visible de la vista pública, tal como se solicitó.

2. **Privado (Panel de Administración):**
   - Acceso protegido por contraseña maestra: `SUPERV1S0R`.
   - Gestión de equipos (activar/desactivar, agregar, renombrar, eliminar).
   - Aprobación o rechazo de solicitudes de registro de nuevos jugadores.
   - Generación de planillas y carnets masivos en Word (DOCX).
   - Subida masiva de fotos, recorte y centrado inteligente.
