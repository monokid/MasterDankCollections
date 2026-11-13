"""Every tooltip in the app, in one place. Plain words, one or two short sentences.

Keys are what `tooltip.tip(widget, "key")` takes. tests/test_gui_help.py fails if a
key used in the code is missing here, or a text here is never used, so this file
cannot drift. Texts that name an option must match the label on screen.
"""

HELP = {
    # ---- shared playlist folder + file list
    "sel_folder": "The folder that holds the playlist. Subfolders count as phases "
                  "(like Warm up, Peak) unless you turn that off in the ... menu.",
    "sel_browse": "Pick the playlist folder with the usual folder window.",
    "sel_up": "Move the highlighted files up one place. You can also drag a file.",
    "sel_down": "Move the highlighted files down one place. You can also drag a file.",
    "sel_more": "Tick or untick everything, sort by name, reverse the order, or choose "
                "whether subfolders count as phases.",
    "sel_tree": "The playlist. Click a tick box to leave a file out, drag to reorder. "
                "Hover a row to see its format and size.",
    "col_inc": "Ticked files are used by Cloak, Check and Spotify. Press Space to flip the "
               "highlighted rows.",
    "col_n": "Position in the playlist. Cloak and Spotify keep this order.",
    "col_name": "File name. Drag a row up or down to reorder.",
    "col_phase": "The subfolder the file sits in. Only shown when your folder has subfolders.",
    "col_dur": "How long the track plays. Filled in a moment after the list appears.",
    "col_st": "Result of the last integrity check: tick is fine, triangle a warning, cross a "
              "broken file.",

    # ---- tabs
    "tab_cloak": "Make an anonymous copy of a playlist that is safe to share.",
    "tab_check": "Look for broken or cut-off audio files before you share or play them.",
    "tab_spotify": "Find your tracks on Spotify and build a playlist in your own account.",
    "tab_dig": "Scan a whole music library into one small file. Only needed if you were "
               "asked to send a scan back.",

    # ---- progress
    "stop": "Stop after the file it is working on. Nothing already finished is undone.",

    # ---- cloak
    "info_cloak": "Makes a copy of your files with every tag removed (artist, title, cover "
                  "art, lyrics, comments). Your originals are never changed. You get two "
                  "folders: one to share, and a private record of which name is which song.",
    "card_true": "Every file is renamed anon_ and a random number. Nothing about the song "
                 "survives except the audio.",
    "card_kinda": "Names say who the playlist is for and which phase a track sits in, never "
                  "what the song is.",
    "card_switch": "Real names are swapped for believable made-up ones, so the list still "
                   "reads like a real playlist.",
    "cloak_person": "The name that goes into every file name, like Sam in anon_Sam_Peak_03.",
    "cloak_phase": "An optional phase to put in every file name, like Peak. Not needed if "
                   "your subfolders already name the phases.",
    "cloak_out_change": "Choose a different place for the copies. It must be a new folder, "
                        "never inside your playlist.",
    "cloak_go": "Checks each file, then makes the anonymous copies. Files that fail the "
                "check are left out and listed. Your originals are never changed.",
    "cloak_preview": "Shows what each file would be called, without copying anything.",
    "cloak_seed": "Leave as random. Type a number to get exactly the same new names again "
                  "on another run.",
    "cloak_deep": "Listens to every second of every file before copying, to catch breaks "
                  "in the middle. Takes minutes. A quick structure check always runs anyway.",
    "adv_toggle": "Extra options. The defaults are right for most people.",
    "open_anon": "Opens the folder with the anonymous copies. This is the one to share.",
    "open_record": "Opens the private record that maps new names back to real songs. "
                   "Keep it to yourself.",
    "cloak_again": "Go back to the options to make another cloaked copy.",

    # ---- check
    "info_check": "Checks that each file is complete and plays without breaks. It only "
                  "reads your files; it never fixes, moves or deletes anything.",
    "check_quick": "Reads each file's structure. Takes seconds and catches cut-off or "
                   "damaged files.",
    "check_thorough": "Decodes every second of every file. Takes minutes, but also catches "
                      "broken audio in the middle of a file.",
    "check_go": "Checks every ticked file with the method chosen on the left.",
    "check_report": "Saves the results as a spreadsheet (CSV) with a short text summary "
                    "beside it.",
    "check_table": "Double-click a row for the plain-language reason. Click a column "
                   "heading to sort.",
    "check_ffmpeg": "Thorough can only decode MP3, FLAC, WAV and OGG on its own. Other "
                    "formats get the quick check. Put ffmpeg.exe next to this app to "
                    "cover them.",
    "col_res_level": "How the file did: fine, warning or failed.",
    "col_res_name": "The file that was checked.",
    "col_res_reason": "What was found, in plain words. Double-click the row for more.",
    "col_res_engine": "How the file was checked: structure only, or a full decode.",

    # ---- spotify
    "info_spotify": "Looks each track up on Spotify and builds a playlist in your account. "
                    "You sign in with your own account in your browser; this app never "
                    "sees your password.",
    "sp_step1": "Step 1: sign in with your Spotify account.",
    "sp_step2": "Step 2: look your tracks up on Spotify.",
    "sp_step3": "Step 3: check the matches and create the playlist.",
    "sp_signin": "Opens your browser so you can approve access. Nothing is posted "
                 "without your say-so.",
    "sp_cancel": "Give up waiting for the browser.",
    "sp_signout": "Forgets your Spotify sign-in on this PC.",
    "sp_name": "The name the new playlist gets in your Spotify.",
    "sp_find": "Searches Spotify for every ticked file, using its real artist and title.",
    "sp_record": "Use the private record.csv from a Cloak run instead of the selected files.",
    "sp_use_sel": "Go back to using the files ticked in the list.",
    "sp_choose": "Pick a different Spotify match for the highlighted track, or skip it.",
    "sp_skip": "Leave the highlighted track out of the playlist.",
    "sp_accept": "Take Spotify's top choice for every track it was unsure about.",
    "sp_create": "Creates the playlist in your Spotify with every track marked with a tick.",
    "sp_open": "Opens the finished playlist in Spotify.",
    "sp_missing": "Saves a spreadsheet of the tracks Spotify did not have, so you can look "
                  "for them elsewhere.",
    "sp_public": "Anyone can find a public playlist. Leave this off for a private one.",
    "sp_table": "Tick means matched, question mark means unsure, cross means not found. "
                "Double-click a row to change the match.",
    "col_sp_st": "Tick: will be added. Question mark: unsure. Cross: not found.",
    "col_sp_src": "The track as it is in your files or record.csv.",
    "col_sp_match": "What Spotify offered for it.",
    "col_sp_score": "How sure the match is.",
    "sp_cid": "Paste the Client ID of the Spotify app here. It is 32 letters and numbers.",
    "sp_cid_save": "Saves the Client ID next to this app.",
    "sp_copy_uri": "Copies the redirect address that must be added to the Spotify app.",
    "sp_dashboard": "Opens the Spotify developer dashboard in your browser.",

    # ---- dig
    "info_dig": "Reads names, tags and audio facts for every track under a folder into one "
                "small JSON file next to this app. Nothing is moved, copied or uploaded.",
    "dig_folder": "The folder that holds your whole music library.",
    "dig_browse": "Pick the library folder with the usual folder window.",
    "dig_go": "Starts the scan. A big library can take a while; you can stop at any time.",
    "dig_cache": "Skips files that have not changed since the last scan, which makes a "
                 "repeat scan much faster.",
}
