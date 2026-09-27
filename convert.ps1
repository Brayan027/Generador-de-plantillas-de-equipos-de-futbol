param(
    [string]$DocxPath,
    [string]$PdfPath
)

$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
    $doc = $word.Documents.Open($DocxPath)
    Write-Host "Word abrió el archivo correctamente!"

    # Forzar orientación Horizontal (Landscape) de 11 x 8.5 pulgadas
    $doc.PageSetup.Orientation = 1 # 1 = wdOrientLandscape
    $doc.PageSetup.PageWidth = 792 # 11 pulgadas en puntos
    $doc.PageSetup.PageHeight = 612 # 8.5 pulgadas en puntos
    # Mantener los márgenes mínimos originales de la plantilla (170 dxa = 8.5 pt)
    $doc.PageSetup.TopMargin = 8.5
    $doc.PageSetup.BottomMargin = 8.5
    $doc.PageSetup.LeftMargin = 8.5
    $doc.PageSetup.RightMargin = 8.5

    # Desactivar compresión de imágenes de Word para preservar nitidez original Full HD
    try { $word.Options.DoNotCompressPictures = $true } catch {}

    if ($PdfPath) {
        # ExportAsFixedFormat: Format=17 (PDF), OpenAfterExport=$false, OptimizeFor=0 (wdExportOptimizeForPrint = 300+ DPI)
        $doc.ExportAsFixedFormat($PdfPath, 17, $false, 0)
        Write-Host "PDF exportado en horizontal a máxima resolución Full HD: $PdfPath"
    }
    $doc.Close([ref]0)
} catch {
    Write-Host "Error en conversión Word COM: $_"
} finally {
    $word.Quit()
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}
