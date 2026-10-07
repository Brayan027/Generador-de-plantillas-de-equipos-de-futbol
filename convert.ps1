param(
    [string]$DocxPath,
    [string]$PdfPath
)

$word = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0 # 0 = wdAlertsNone (Desactiva avisos de márgenes fuera de área imprimible)
    try { $word.AutomationSecurity = 3 } catch {} # 3 = msoAutomationSecurityForceDisable
    $word.ScreenUpdating = $false

    # Abrir como sólo lectura ($true) para evitar bloqueos
    $doc = $word.Documents.Open($DocxPath, $false, $true)
    Write-Host "Word abrió el archivo correctamente!"

    # Forzar orientación Horizontal (Landscape) de 11 x 8.5 pulgadas
    $doc.PageSetup.Orientation = 1 # 1 = wdOrientLandscape
    $doc.PageSetup.PageWidth = 792 # 11 pulgadas en puntos
    $doc.PageSetup.PageHeight = 612 # 8.5 pulgadas en puntos
    $doc.PageSetup.TopMargin = 8.5
    $doc.PageSetup.BottomMargin = 8.5
    $doc.PageSetup.LeftMargin = 8.5
    $doc.PageSetup.RightMargin = 8.5

    # Desactivar compresión de imágenes de Word
    try { $word.Options.DoNotCompressPictures = $true } catch {}

    if ($PdfPath) {
        $doc.ExportAsFixedFormat($PdfPath, 17, $false, 0)
        Write-Host "PDF exportado exitosamente: $PdfPath"
    }
    $doc.Close([ref]0)
} catch {
    Write-Host "Error en conversión Word COM: $_"
} finally {
    if ($word) {
        try { $word.Quit([ref]0) } catch {}
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
    }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}
