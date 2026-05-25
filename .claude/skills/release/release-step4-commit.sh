#!/usr/bin/env bash
# Stage manifest.json + RELEASE.md and commit the version bump.
# Usage: release-step4-commit.sh <NEW_TAG>
NEW_TAG="${1:?Usage: $0 <new-tag>}"

git add manifest.json RELEASE.md
git commit -m "chore: bump version to ${NEW_TAG}"
