# Convenience launcher (Windows PowerShell): activate the venv, run the CLI.
#
# Set up a shortcut once, then use `igsort ...` from any terminal:
#   notepad $PROFILE      # add:  function igsort { & "C:\path\to\IG-Saved-Sorter\run.ps1" @args }
#   igsort sync -u your_username --collection "Recipes"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

if (Test-Path ".venv\Scripts\Activate.ps1") {
    . .venv\Scripts\Activate.ps1
}

ig-saved-sorter @args
