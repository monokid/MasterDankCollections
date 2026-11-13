# Builds crawler/dist/DankCrawl.exe and the package to hand to friends:
#   dist/DankCrawl-friends/        DankCrawl.exe + spotify_client.json (empty template) + README-friends.txt
#   dist/DankCrawl-friends.zip     the same, zipped
# miniaudio is a cffi module: the deep integrity check needs --collect-all miniaudio and _cffi_backend.
# The window lives in the gui/ package and loads each tab module on first use (importlib), which
# PyInstaller cannot see, hence --collect-submodules gui.
Set-Location $PSScriptRoot
python -m pip install -r requirements.txt
python -m PyInstaller --noconfirm --onefile --windowed --name DankCrawl `
  --hidden-import mutagen --collect-submodules mutagen `
  --collect-submodules gui `
  --collect-all miniaudio --hidden-import _cffi_backend `
  --additional-hooks-dir pyi_hooks `
  --hidden-import _baked_client `
  --exclude-module numpy --exclude-module PIL --exclude-module pytest `
  dankcrawl.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed ($LASTEXITCODE)" }

$pkg = Join-Path $PSScriptRoot "dist\DankCrawl-friends"
if (Test-Path $pkg) { Remove-Item -Recurse -Force $pkg }
New-Item -ItemType Directory -Path $pkg | Out-Null
Copy-Item "dist\DankCrawl.exe" $pkg
Copy-Item "friends\spotify_client.json" $pkg
Copy-Item "friends\README-friends.txt" $pkg
$zip = Join-Path $PSScriptRoot "dist\DankCrawl-friends.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path "$pkg\*" -DestinationPath $zip
Write-Host "built -> $PSScriptRoot\dist\DankCrawl.exe"
Write-Host "friends package -> $pkg  and  $zip"
Write-Host "check it:  dist\DankCrawl.exe --selftest --log selftest.txt   (windowed exe: output goes to the log file)"
