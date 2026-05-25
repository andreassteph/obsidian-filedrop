---
name: release
description: Use this skill when the user wants to cut a new release, publish a new version, tag a release, or says "/release". It guides through picking a semver tag, updating manifest.json and RELEASE.md, committing, and running release.sh to publish to GitHub.
version: 0.1.0
---

# Release Skill

Guides the user through publishing a new GitHub release for the obsidian-filedrop plugin so it can be installed via BRAT.

## Steps

### 1. Determine the current latest tag

Run:
```bash
git fetch --tags && git describe --tags --abbrev=0 2>/dev/null || echo "none"
```

Parse the result as `CURRENT` (e.g. `0.1.0`). If no tag exists yet, treat `CURRENT` as `0.0.0`.

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

Run these in parallel and surface any failures before proceeding:

```bash
# Check gh CLI is installed
which gh || echo "MISSING_GH"

# Check gh is authenticated
gh auth status 2>&1 || echo "NOT_AUTHED"

# Check for uncommitted changes
git status --porcelain

# Check current branch
git branch --show-current

# Check if tag already exists
git tag -l "<NEW_TAG>"
```

Abort with a clear message if:
- `gh` is not installed → tell user to install it: `sudo apt install gh` or https://cli.github.com/
- `gh` is not authenticated → `gh auth login`
- There are uncommitted changes → list them, ask user to commit or stash first
- Not on the `main` branch → warn and ask for confirmation
- Tag already exists → error, cannot overwrite

### 5. Update manifest.json

Read `manifest.json`, update the `"version"` field to the new tag, write it back.

### 6. Gather changes since last release

Run the following to get commits since the previous tag:

```bash
git log <CURRENT_TAG>..HEAD --oneline --no-merges
```

If there is no previous tag, use `git log --oneline --no-merges` to get all commits.

Also run a summary of changed files for context:

```bash
git diff <CURRENT_TAG>..HEAD --stat
```

Read through the commits and changed files. Synthesize them into:
- A short one-sentence release title (what this release is about overall)
- 2–5 concrete bullet points covering what actually changed (group related commits, skip noise like formatting or typo fixes unless they matter to users)

Do not ask the user — derive this entirely from the git output. Write in plain present tense ("Add X", "Fix Y", "Improve Z").

### 7. Update RELEASE.md

Prepend a new section at the top of RELEASE.md (below the `# Release Notes` heading):

```markdown
## <NEW_TAG> — <derived title>

### Changes

- <bullet derived from git log>
- ...
```

Show the drafted section to the user and ask for a quick confirmation or any edits before writing it to the file.

### 8. Commit the version bump

Stage and commit only `manifest.json` and `RELEASE.md`:

```bash
git add manifest.json RELEASE.md
git commit -m "chore: bump version to <NEW_TAG>"
```

### 9. Run the release script

```bash
./release.sh <NEW_TAG>
```

This script handles: building, creating the git tag, pushing, and creating the GitHub release with the required BRAT assets.

### 10. Confirm success

After `release.sh` completes, print the GitHub release URL and remind the user the BRAT install string: `andreassteph/obsidian-filedrop`.
