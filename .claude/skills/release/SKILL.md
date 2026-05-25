---
name: release
description: Use this skill when the user wants to cut a new release, publish a new version, tag a release, or says "/release". It guides through picking a semver tag, updating manifest.json and RELEASE.md, committing, and running release.sh to publish to GitHub.
version: 0.2.0
---

# Release Skill

Guides the user through publishing a new GitHub release for the obsidian-filedrop plugin so it can be installed via BRAT.

All shell work is done via scripts in `.claude/skills/release/`. Never run raw git or gh commands directly.

## Steps

### 1. Determine the current latest tag

Run:
```bash
.claude/skills/release/release-step1-get-tag.sh
```

Parse the output as `CURRENT` (e.g. `0.1.0`). If the output is `none`, treat `CURRENT` as `0.0.0`.

### 2. Compute suggested versions

From `MAJOR.MINOR.PATCH`:
- **Patch** → increment PATCH by 1 (bug fixes / small tweaks)
- **Minor** → increment MINOR by 1, reset PATCH to 0 (new features)

### 3. Ask the user which tag to use

Present exactly three options using AskUserQuestion:
- Option 1: Patch bump (e.g. `0.1.1`) — "Bug fixes and small changes (Recommended)"
- Option 2: Minor bump (e.g. `0.2.0`) — "New features, backwards compatible"
- Option 3: Custom — "Enter your own tag"

If the user picks Custom, ask them to type the tag.

Validate the tag matches `^\d+\.\d+\.\d+$` (plain semver, no `v` prefix).

### 4. Pre-flight checks — run before making any changes

Run:
```bash
.claude/skills/release/release-step2-preflight.sh <NEW_TAG>
```

The script prints `KEY=VALUE` lines. Parse them and abort with a clear message if:
- `GH_OK=false` → tell user to install gh: `sudo apt install gh` or https://cli.github.com/
- `AUTHED=false` → tell user to run `gh auth login`
- `DIRTY_COUNT` > 0 → list the `DIRTY_FILE=` lines, ask user to commit or stash first
- `BRANCH` is not `main` → warn and ask for confirmation before continuing
- `TAG_EXISTS=true` → error, cannot overwrite an existing tag

### 5. Update manifest.json

Read `manifest.json`, update the `"version"` field to the new tag, write it back using the Edit tool.

### 6. Gather changes since last release

Run:
```bash
.claude/skills/release/release-step3-changes.sh <CURRENT_TAG>
```

Pass `none` as `CURRENT_TAG` if there was no previous tag.

The output contains a `=== COMMITS ===` section and a `=== STAT ===` section. Read through both and synthesize:
- A short one-sentence release title (what this release is about overall)
- 2–5 concrete bullet points covering what actually changed (group related commits, skip noise like formatting or typo fixes unless they matter to users)

Do not ask the user — derive this entirely from the script output. Write in plain present tense ("Add X", "Fix Y", "Improve Z").

### 7. Update RELEASE.md

Prepend a new section at the top of RELEASE.md (below the `# Release Notes` heading):

```markdown
## <NEW_TAG> — <derived title>

### Changes

- <bullet derived from git log>
- ...
```

Show the drafted section to the user and ask for a quick confirmation or any edits before writing it to the file using the Edit tool.

### 8. Commit the version bump

Run:
```bash
.claude/skills/release/release-step4-commit.sh <NEW_TAG>
```

### 9. Run the release script

```bash
./release.sh <NEW_TAG>
```

This script handles: building, creating the git tag, pushing, and creating the GitHub release with the required BRAT assets.

### 10. Confirm success

After `release.sh` completes, print the GitHub release URL and remind the user the BRAT install string: `andreassteph/obsidian-filedrop`.
