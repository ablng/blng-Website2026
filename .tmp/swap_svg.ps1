$img = '<img src="assets/blng studio.png" alt="blng studio">'
$base = Split-Path $PSScriptRoot -Parent
$files = @('work.html','about.html','project.html','contact.html')
foreach ($f in $files) {
  $path = Join-Path $base $f
  $c = [System.IO.File]::ReadAllText($path)
  $c = [System.Text.RegularExpressions.Regex]::Replace($c, '<svg[\s\S]*?</svg>', $img, [System.Text.RegularExpressions.RegexOptions]::Singleline)
  [System.IO.File]::WriteAllText($path, $c, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Done: $f"
}
