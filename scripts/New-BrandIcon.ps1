param([Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# Match the MeetOnTrack M-and-dot mark used by the Mac app. Generated files stay in obj;
# source control contains the renderer, not a copied upstream binary icon.
$sizes = @(16, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stream = New-Object System.IO.MemoryStream
    $background = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(23, 76, 62))
    $field = New-Object System.Drawing.Drawing2D.GraphicsPath
    $mark = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(243, 244, 239), [single]($size * 6 / 64))
    $dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 234, 227))
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $lo = [single]($size * .06)
        $diameter = [single]($size * .46)
        $hi = [single]($size * .94 - $diameter)
        $field.AddArc($lo, $lo, $diameter, $diameter, 180, 90)
        $field.AddArc($hi, $lo, $diameter, $diameter, 270, 90)
        $field.AddArc($hi, $hi, $diameter, $diameter, 0, 90)
        $field.AddArc($lo, $hi, $diameter, $diameter, 90, 90)
        $field.CloseFigure()
        $graphics.FillPath($background, $field)
        $points = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new($size * 14/64, $size * 45/64),
            [System.Drawing.PointF]::new($size * 14/64, $size * 19/64),
            [System.Drawing.PointF]::new($size * 32/64, $size * 36/64),
            [System.Drawing.PointF]::new($size * 50/64, $size * 19/64),
            [System.Drawing.PointF]::new($size * 50/64, $size * 45/64)
        )
        $mark.AddLines($points)
        $pen.StartCap = $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $graphics.DrawPath($pen, $mark)
        $graphics.FillEllipse($dot, [single]($size * 28/64), [single]($size * 42/64), [single]($size * 8/64), [single]($size * 8/64))
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $images += ,($stream.ToArray())
    } finally {
        $field.Dispose(); $mark.Dispose(); $pen.Dispose(); $dot.Dispose()
        $background.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose()
    }
}
$destination = [System.IO.Path]::GetFullPath($OutputPath)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination)) | Out-Null
$file = [System.IO.File]::Create($destination)
$writer = New-Object System.IO.BinaryWriter($file)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dimension = [byte]($sizes[$i] % 256)
        $writer.Write($dimension); $writer.Write($dimension)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$images[$i].Length); $writer.Write([uint32]$offset)
        $offset += $images[$i].Length
    }
    foreach ($bytes in $images) { $writer.Write([byte[]]$bytes) }
} finally { $writer.Dispose() }
