DankCrawl - friends edition
===========================

What it is
  One small program, no installer. Double-click DankCrawl.exe.
  Keep spotify_client.json in the same folder as the exe.
  Hover over anything to see what it does.

What it does (four tabs)
  Cloak    The main job. Makes an anonymous COPY of a playlist (see below).
  Check    Looks for broken or cut-off audio files. Quick takes seconds;
           Thorough listens to every second and takes minutes.
  Spotify  Finds your tracks on Spotify and builds a playlist in YOUR account.
  Dig      Reads the names and tags of a whole music library into one small file.
           Only if you were asked to send a scan back; otherwise ignore it.

How to use it
  1. Pick your playlist folder at the top (type it, paste it, or press Browse).
  2. Choose a tab and press its big button. The defaults are right for most people;
     "Advanced" hides the rare options.

Your music is safe
  Your original files are never changed, moved, renamed or deleted. DankCrawl only
  reads them. Everything it makes goes into a NEW folder next to your playlist
  folder (called "DankCloak <date>").

The three ways to cloak
  Completely anonymous  every file becomes anon_<random number>.mp3
                        (any other format keeps its own ending)
  Keep who & where      anon_<Person>_<Phase>_<number>, e.g. anon_Sam_Peak_03.mp3
  Switcheroo            real names swapped for believable fake ones
  In every mode the copies lose ALL tags, cover art, lyrics and comments.
  Every file gets a quick check first. A broken file is left out and listed, never
  copied. Tip: if your playlist folder has subfolders (Warm up, Peak, ...) they
  become the phases (turn that off in the "..." menu above the file list).

Which folder to share
  When it finishes, the "DankCloak <date>" folder opens. It holds two folders:
    anonymised   <- the ONLY one to send to anybody
    record       <- PRIVATE. It maps every new name back to the real song. Never share it.

Signing in to Spotify
  1. Open the Spotify tab and press "Sign in with Spotify". Your browser opens; approve.
  2. You sign in with your OWN Spotify account. DankCrawl never sees your password.
  3. The owner of DankCrawl must have added your Spotify email address on their list
     of allowed users first. If you see "not on the allowed list", send them the email
     address of your Spotify account and try again once they say it is added.
  4. Press "Find tracks", check the ones it was unsure about (or "Accept all best
     guesses"), then "Create playlist".
  If the tab asks for a Client ID instead, spotify_client.json is missing or empty:
  ask the owner for the right one.
  "Sign out" (top right of the tab) removes your saved sign-in from this PC.

Windows may warn about it
  The program is not code-signed, so Windows SmartScreen may say "Windows protected
  your PC", and some antivirus tools flag any unsigned program built this way. If you
  trust where it came from: click "More info", then "Run anyway". If your antivirus
  quarantines it, add DankCrawl.exe to its allowed list.

Good to know
  * Settings (window size, last tab, your Spotify sign-in) live in  %APPDATA%\DankCrawl
  * Thorough check covers MP3, FLAC, WAV and OGG. For M4A, Opus and AIFF it needs a free
    tool called ffmpeg (ffmpeg.exe placed next to DankCrawl.exe); without it those
    files still get the quick check.
  * Keyboard: Enter presses the big button, Esc closes a window, Alt+C / K / S / D
    jump to the Cloak / Check / Spotify / Dig tab.
  * Hidden extras exist. Try clicking the title.
