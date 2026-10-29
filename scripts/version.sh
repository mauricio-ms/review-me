#!/bin/sh
# version.sh — print review-me's version for this checkout.
#
# package.json's major.minor, then the number of commits: it goes up by itself with
# every commit, and the same code always gets the same number. A tree with
# uncommitted changes adds `-dev`, so a build of work in progress never passes for
# the commit it started from. vite.config.ts stamps it into the app;
# packaging/build-ubuntu.sh also puts it on the .deb.
set -eu
cd "$(dirname "$0")/.."
base=$(node -p 'require("./package.json").version.split(".").slice(0, 2).join(".")')
count=$(git rev-list --count HEAD)
dirty=$(git status --porcelain)
printf '%s.%s%s\n' "$base" "$count" "${dirty:+-dev}"
