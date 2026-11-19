# Rasterise the original vector brand mark for Chrome's PNG icon slots.
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
$extensionRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$iconDirectory = Join-Path $extensionRoot 'assets/icons'
New-Item -ItemType Directory -Path $iconDirectory -Force | Out-Null
[xml]$logo = Get-Content -LiteralPath (Join-Path $extensionRoot 'assets/obltech-logo.svg') -Raw
$mark = @($logo.svg.path)[0..6]
$bounds = [System.Windows.Rect]::Empty
foreach ($shape in $mark) {
    $geometry = [System.Windows.Media.Geometry]::Parse($shape.d)
    $bounds.Union($geometry.Bounds)
}
foreach ($iconSize in @(16, 32, 48, 128, 256)) {
    $visual = [System.Windows.Media.DrawingVisual]::new()
    $drawing = $visual.RenderOpen()
    $tileMargin = $iconSize * 0.025
    $tile = [System.Windows.Rect]::new($tileMargin, $tileMargin, $iconSize - 2 * $tileMargin, $iconSize - 2 * $tileMargin)
    $drawing.DrawRoundedRectangle([System.Windows.Media.Brushes]::White, $null, $tile, $iconSize * 0.18, $iconSize * 0.18)
    $scale = $iconSize * 0.84 / [Math]::Max($bounds.Width, $bounds.Height)
    $offsetX = ($iconSize - $bounds.Width * $scale) / 2 - $bounds.X * $scale
    $offsetY = ($iconSize - $bounds.Height * $scale) / 2 - $bounds.Y * $scale
    $transform = [System.Windows.Media.MatrixTransform]::new($scale, 0, 0, $scale, $offsetX, $offsetY)
    $drawing.PushTransform($transform)
    foreach ($shape in $mark) {
        $color = [System.Windows.Media.ColorConverter]::ConvertFromString($shape.fill)
        $brush = [System.Windows.Media.SolidColorBrush]::new($color)
        $drawing.DrawGeometry($brush, $null, [System.Windows.Media.Geometry]::Parse($shape.d))
    }
    $drawing.Pop()
    $drawing.Close()
    $bitmap = [System.Windows.Media.Imaging.RenderTargetBitmap]::new($iconSize, $iconSize, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($visual)
    $encoder = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [System.IO.File]::Create((Join-Path $iconDirectory "icon-$iconSize.png"))
    try { $encoder.Save($stream) } finally { $stream.Dispose() }
}
