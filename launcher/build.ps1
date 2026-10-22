# Builds launcher/dist/MasterDankCollections.exe -- the one-double-click launcher.
Set-Location $PSScriptRoot
python -m PyInstaller --noconfirm --onefile --windowed `
  --name MasterDankCollections `
  --paths "$PSScriptRoot\..\crawler" `
  --hidden-import widgets --hidden-import steps `
  --exclude-module numpy --exclude-module PIL --exclude-module mutagen `
  --exclude-module pytest `
  launch.py
Write-Host "built -> $PSScriptRoot\dist\MasterDankCollections.exe"
