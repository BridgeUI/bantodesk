# 18 資料パネル (Windows): PowerPoint の COM で pptx の各スライドを PNG に書き出す。アプリが `-File` でこのファイルのパスを渡して起動する。
# 引数: pptx のパス、出力フォルダ、幅 (px)、書き出すスライド番号（省略 = 全部、カンマ区切り）。出力は <フォルダ>\<n>.png
param([string]$Pptx, [string]$OutDir, [int]$Width = 1600, [string]$Only = '')
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject PowerPoint.Application
$opened = $null
try {
  $opened = $app.Presentations.Open($Pptx, -1, 0, 0) # ReadOnly, Untitled, WithWindow = false
  $w = [int]$Width
  $h = [int][math]::Round($w * $opened.PageSetup.SlideHeight / $opened.PageSetup.SlideWidth)
  $want = @()
  if ($Only) { $want = $Only.Split(',') | ForEach-Object { [int]$_ } }
  $count = $opened.Slides.Count
  for ($i = 1; $i -le $count; $i++) {
    if ($want.Count -gt 0 -and ($want -notcontains $i)) { continue }
    $opened.Slides.Item($i).Export((Join-Path $OutDir "$i.png"), 'PNG', $w, $h)
  }
} finally {
  if ($opened) { $opened.Close() }
  if ($app.Presentations.Count -eq 0) { $app.Quit() }
}
