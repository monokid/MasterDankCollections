# Builds crawler/dist/DankCrawl.exe -- the single file to send to a library owner.
Set-Location $PSScriptRoot
python -m pip install -r requirements.txt
python -m PyInstaller --noconfirm --onefile --windowed --name DankCrawl `
  --hidden-import mutagen --collect-submodules mutagen `
  --exclude-module numpy --exclude-module PIL --exclude-module pytest `
  dankcrawl.py
Write-Host "built -> $PSScriptRoot\dist\DankCrawl.exe"
