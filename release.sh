#!/usr/bin/env bash
# Usage: ./release.sh <TAG>
# Builds, tags, and publishes a GitHub release.
# Requires: gh CLI (https://cli.github.com/) authenticated with push access.

set -euo pipefail

TAG="${1:-}"

# ── Validate tag argument ────────────────────────────────────────────────────
if [[ -z "$TAG" ]]; then
  echo "Error: tag argument is required." >&2
  echo "Usage: $0 <TAG>   (e.g. $0 0.2.0)" >&2
  exit 1
fi

if ! [[ "$TAG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: tag must be plain semver (MAJOR.MINOR.PATCH), got: $TAG" >&2
  exit 1
fi

echo "Preparing release $TAG..."

# ── Pre-flight checks ────────────────────────────────────────────────────────
FAIL=0

if ! command -v gh &>/dev/null; then
  echo "Error: gh CLI not found. Install from https://cli.github.com/" >&2
  FAIL=1
fi

if ! gh auth status &>/dev/null; then
  echo "Error: gh CLI not authenticated. Run: gh auth login" >&2
  FAIL=1
fi

DIRTY=$(git status --porcelain)
if [[ -n "$DIRTY" ]]; then
  echo "Error: working tree has uncommitted changes:" >&2
  echo "$DIRTY" >&2
  FAIL=1
fi

BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Warning: not on main branch (currently on '$BRANCH'). Press Ctrl-C to abort, Enter to continue."
  read -r
fi

if git tag -l "$TAG" | grep -q "^${TAG}$"; then
  echo "Error: tag $TAG already exists locally. Delete it first: git tag -d $TAG" >&2
  FAIL=1
fi

MANIFEST_VERSION=$(node -e "console.log(require('./manifest.json').version)" 2>/dev/null || echo "")
if [[ "$MANIFEST_VERSION" != "$TAG" ]]; then
  echo "Error: manifest.json version ($MANIFEST_VERSION) does not match tag ($TAG)." >&2
  echo "Update manifest.json before running this script." >&2
  FAIL=1
fi

[[ $FAIL -eq 1 ]] && exit 1

# ── Build ────────────────────────────────────────────────────────────────────
echo "Building plugin..."
npm run build

# ── Tag and push ─────────────────────────────────────────────────────────────
echo "Creating tag $TAG..."
git tag "$TAG"

echo "Pushing commits and tag..."
git push origin main
git push origin "$TAG"

# ── Create GitHub release ────────────────────────────────────────────────────
echo "Creating GitHub release $TAG..."
gh release create "$TAG" \
  main.js manifest.json styles.css \
  --title "$TAG" \
  --notes-file RELEASE.md

echo ""
echo "Release $TAG published."
echo "BRAT install: andreassteph/obsidian-filedrop"
