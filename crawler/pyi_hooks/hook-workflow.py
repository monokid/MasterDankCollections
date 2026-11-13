# Deliberately empty. PyInstaller-contrib ships a hook named hook-workflow.py for an
# unrelated third-party package called "workflow"; it fires on OUR crawler/workflow.py
# and crashes the build (ImportErrorWhenRunningHook). A hook of the same name found via
# --additional-hooks-dir takes precedence, so this one switches the stock hook off.
