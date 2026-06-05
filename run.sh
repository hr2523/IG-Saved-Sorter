#!/usr/bin/env bash
# Convenience launcher: cd into the repo, activate the venv, run the CLI.
#
# Set up a shortcut once (zsh/bash), then use `igsort ...` from any terminal:
#   echo 'alias igsort="'"$(pwd)"'/run.sh"' >> ~/.zshrc && source ~/.zshrc
#   igsort sync -u your_username --collection "Recipes"
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ -d ".venv" ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

exec ig-saved-sorter "$@"
