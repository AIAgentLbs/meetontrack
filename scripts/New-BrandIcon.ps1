param([Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# Match the five-bar waveform used by the Mac app. Generated files stay in obj;
# source control contains the renderer, not a copied upstream binary icon.
$sizes = @(16, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stream = New-Object System.IO.MemoryStream
    $background = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(14, 65, 52))
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.FillEllipse($background, [single]($size * .04), [single]($size * .04), [single]($size * .92), [single]($size * .92))
        $width = [single][Math]::Max(1, $size * .075)
        $gap = [single]($size * .065)
        $x = [single](($size - (5 * $width + 4 * $gap)) / 2)
        foreach ($ratio in @(.26, .48, .72, .48, .26)) {
            $height = [single]($size * $ratio)
            $graphics.FillRectangle([System.Drawing.Brushes]::White, $x, [single](($size - $height) / 2), $width, $height)
            $x += $width + $gap
        }
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $images += ,($stream.ToArray())
    } finally {
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
