#!/usr/bin/env bash
# Print commits and file-change stats since the given tag.
# Usage: release-step3-changes.sh <CURRENT_TAG>
# If CURRENT_TAG is "none", shows all commits.
CURRENT_TAG="${1:?Usage: $0 <current-tag>}"

if [[ "$CURRENT_TAG" == "none" ]]; then
  echo "=== COMMITS ==="
  git log --oneline --no-merges
  echo ""
  echo "=== STAT ==="
  git diff --stat
else
  echo "=== COMMITS ==="
  git log "${CURRENT_TAG}..HEAD" --oneline --no-merges
  echo ""
  echo "=== STAT ==="
  git diff "${CURRENT_TAG}..HEAD" --stat
fi
