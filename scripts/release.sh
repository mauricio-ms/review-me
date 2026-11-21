#!/bin/sh
# release.sh — tag the current commit as a release.
#
#   ./scripts/release.sh
#
# A release's version is scripts/version.sh's (package.json's major.minor plus the commit
# count), so cutting one is only a tag on a clean master: this script checks that and
# creates the annotated tag `v<version>`. Pushing the tag starts
# .github/workflows/release.yml, which runs the tests, builds the Linux packages and
# drafts a GitHub release for you to review and publish.
set -eu
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "release.sh: the working tree has changes; commit or stash them first" >&2
  exit 1
fi
branch=$(git symbolic-ref --short -q HEAD || true)
if [ "$branch" != master ]; then
  echo "release.sh: releases are tagged on master (this is ${branch:-a detached HEAD})" >&2
  exit 1
fi

version=$(./scripts/version.sh)
tag="v$version"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "release.sh: $tag already exists" >&2
  exit 1
fi

git tag -a "$tag" -m "review-me $version"
echo "Tagged $tag. Push master and the tag to build the release:"
echo
echo "  git push origin master $tag"
