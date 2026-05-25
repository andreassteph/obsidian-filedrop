#!/usr/bin/env bash
# Prints the latest git tag, or "none" if no tags exist.
git fetch --tags 2>/dev/null
git describe --tags --abbrev=0 2>/dev/null || echo "none"
