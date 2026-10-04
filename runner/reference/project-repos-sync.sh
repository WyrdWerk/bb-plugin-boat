#!/usr/bin/env bash
# Reference implementation of the base box's repo sync (see BOX-CONTRACT.md).
# Reads ~/.project-repos.txt (`<name> <https-url>` per line, written by the plugin)
# and makes sure each repo is cloned at ~/workspace/repos/<name>. Existing clean
# repos are fast-forwarded; dirty or diverged ones are left alone. Never deletes.
# Private repos: authenticate git on the base box (e.g. `gh auth setup-git` with a
# GITHUB_TOKEN in the box environment). Never put tokens in the manifest.
set -uo pipefail
M="$HOME/.project-repos.txt"
R="$HOME/workspace/repos"
[ -s "$M" ] || { echo "no manifest at $M"; exit 0; }
mkdir -p "$R"
rc=0
while read -r name url _ || [ -n "${name:-}" ]; do
  case "${name:-}" in ""|\#*) name=""; url=""; continue;; esac
  case "$name" in */*|.*) echo "skip bad name: $name"; rc=1; name=""; url=""; continue;; esac
  d="$R/$name"
  if [ -d "$d/.git" ]; then
    if [ -z "$(git -C "$d" status --porcelain 2>/dev/null)" ]; then
      git -C "$d" pull --ff-only -q 2>/dev/null && echo "updated $name" || echo "kept $name (no fast-forward)"
    else
      echo "kept $name (dirty)"
    fi
  else
    for i in 1 2 3; do
      git clone -q "$url" "$d.tmp.$$" && mv "$d.tmp.$$" "$d" && { echo "cloned $name"; break; }
      rm -rf "$d.tmp.$$"; echo "clone $name failed (attempt $i)"; sleep $((i * 10))
    done
    [ -d "$d/.git" ] || rc=1
  fi
  name=""; url=""
done <"$M"
exit $rc
