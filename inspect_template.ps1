$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
    $doc = $word.Documents.Open("C:\Users\acer\Desktop\QSY\Personal\PLANTILLA_EQUIPOS.docx")
    Write-Host "--- PAGE SETUP ---"
    Write-Host "Orientation: $($doc.PageSetup.Orientation)"
    Write-Host "PageWidth: $($doc.PageSetup.PageWidth) pt ($([math]::Round($doc.PageSetup.PageWidth/72*25.4, 1)) mm)"
    Write-Host "PageHeight: $($doc.PageSetup.PageHeight) pt ($([math]::Round($doc.PageSetup.PageHeight/72*25.4, 1)) mm)"
    Write-Host "TopMargin: $($doc.PageSetup.TopMargin) pt"
    Write-Host "BottomMargin: $($doc.PageSetup.BottomMargin) pt"
    Write-Host "LeftMargin: $($doc.PageSetup.LeftMargin) pt"
    Write-Host "RightMargin: $($doc.PageSetup.RightMargin) pt"
    
    Write-Host "`n--- TABLES ---"
    Write-Host "Total Tables: $($doc.Tables.Count)"
    if ($doc.Tables.Count -ge 1) {
        $t = $doc.Tables.Item(1)
        Write-Host "Table 1 Rows: $($t.Rows.Count), Columns: $($t.Columns.Count)"
        Write-Host "Table 1 Width: $($t.PreferredWidth)"
        if ($t.Rows.Count -ge 1 -and $t.Columns.Count -ge 1) {
            $c = $t.Cell(1, 1)
            Write-Host "Cell(1,1) Width: $($c.Width) pt"
            Write-Host "Cell(1,1) Height: $($c.Height) pt"
            Write-Host "Cell(1,1) Text preview: $($c.Range.Text.Substring(0, [math]::Min(100, $c.Range.Text.Length)))"
            Write-Host "Nested tables in Cell(1,1): $($c.Tables.Count)"
            if ($c.Tables.Count -ge 1) {
                $nt = $c.Tables.Item(1)
                Write-Host "Nested Table Rows: $($nt.Rows.Count), Columns: $($nt.Columns.Count)"
                for ($nr = 1; $nr -le $nt.Rows.Count; $nr++) {
                    for ($nc = 1; $nc -le $nt.Columns.Count; $nc++) {
                        $ncell = $nt.Cell($nr, $nc)
                        Write-Host "  Nested Cell($nr,$nc) Width: $($ncell.Width) pt, Text: $($ncell.Range.Text.Replace("`r"," ").Replace("`n"," ").Trim())"
                    }
                }
            }
        }
    }
    $doc.Close(0)
} catch {
    Write-Host "Error: $_"
} finally {
    $word.Quit()
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
}
