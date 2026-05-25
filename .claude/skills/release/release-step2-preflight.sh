#!/usr/bin/env bash
# Pre-flight checks. Usage: release-step2-preflight.sh <NEW_TAG>
# Exits 0 with a JSON object: { "gh": bool, "authed": bool, "dirty": [...], "branch": str, "tag_exists": bool }
NEW_TAG="${1:?Usage: $0 <new-tag>}"

GH_OK=false
AUTHED=false
DIRTY=()
BRANCH=""
TAG_EXISTS=false

which gh &>/dev/null && GH_OK=true
if $GH_OK; then
  gh auth status &>/dev/null && AUTHED=true
fi

mapfile -t DIRTY < <(git status --porcelain)
BRANCH=$(git branch --show-current)
git tag -l "$NEW_TAG" | grep -q "^${NEW_TAG}$" && TAG_EXISTS=true

# Emit a simple key=value report (easy to parse without jq)
echo "GH_OK=${GH_OK}"
echo "AUTHED=${AUTHED}"
echo "DIRTY_COUNT=${#DIRTY[@]}"
for f in "${DIRTY[@]}"; do echo "DIRTY_FILE=${f}"; done
echo "BRANCH=${BRANCH}"
echo "TAG_EXISTS=${TAG_EXISTS}"
