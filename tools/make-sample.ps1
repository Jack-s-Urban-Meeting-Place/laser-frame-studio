# make-sample.ps1 - rebuilds js/sample-fox.js from a folder of numbered JPG frames.
#
# Usage (from the "Laser Frame Studio" folder):
#   powershell -File tools\make-sample.ps1 -Frames "..\Animations\Fox Test" -Pattern "Fox_*.jpg"
#
# Keep sample frames small (a few KB each): they are embedded in the page as text.

param(
  [Parameter(Mandatory = $true)][string]$Frames,
  [string]$Pattern = "*.jpg"
)

$out = Join-Path $PSScriptRoot "..\js\sample-fox.js"
$lines = @(
  "/*",
  " * sample-fox.js - the built-in sample animation (9 frames of a running fox).",
  " *",
  " * The frames are embedded as base64 JPEGs so the sample works when the page is",
  " * opened straight from disk (browsers block reading local image files' pixels).",
  " * Regenerate with tools/make-sample.ps1 if you want a different sample.",
  " */",
  "'use strict';",
  "",
  "const SAMPLE_FRAMES = ["
)
Get-ChildItem (Join-Path $Frames $Pattern) | Sort-Object Name | ForEach-Object {
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName))
  $lines += "  { name: '$($_.Name)', base64: '$b64' },"
}
$lines += "];"
[IO.File]::WriteAllText($out, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding $false))
Write-Host "Wrote $out"
