---
name: release-workflow
description: Prepare and publish a Jellyfin MPV Play release — version bumps, CHANGELOG, README, PR, tag, CI. Use when the user says "release", "cut a release", "tag a version", or "prepare a version bump".
---

# Release Workflow

Follow these steps exactly. Never skip a step. Never push directly to main.

## Steps

1. **Create a branch**: `git checkout -b release/vX.Y.Z`

2. **Bump version**: `npm version X.Y.Z --no-git-tag-version`
   (updates both `package.json` and `package-lock.json`)

3. **Update Info.plist** (use sed, NOT PlistBuddy):
   ```bash
   sed -i '' 's/old-version/new-version/g' macapp/Info.plist
   ```
   Both `CFBundleVersion` and `CFBundleShortVersionString` must match.

4. **Update CHANGELOG.md**:
   - Add a `## vX.Y.Z` section above the previous release
   - Use the template categories: `### New Features`, `### Bug Fixes`, `### Internal`
   - Keep entries user-facing — no TODO.md attribution or dev housekeeping
   - One-line summary per change, bold lead-in, em-dash, then explanation

5. **Update README.md "Recent Releases"**:
   - Add the new version at the top
   - Keep only the latest 4 in "Recent Releases"
   - Move the 5th into `<details><summary><b>Older releases</b></summary>`
   - NEVER delete a release entry — always move it

6. **Run tests**: `npm test` — all must pass

7. **Commit, push, PR, merge**:
   ```bash
   git add package.json package-lock.json macapp/Info.plist CHANGELOG.md README.md
   git commit -m "release: vX.Y.Z — short description"
   git push origin release/vX.Y.Z
   gh pr create --repo MrGameVlogger/jellyfin-mpv-play --head release/vX.Y.Z --base main --title "release: vX.Y.Z" --body "description"
   gh pr merge <PR_NUMBER> --repo MrGameVlogger/jellyfin-mpv-play --squash
   ```

8. **Tag and push**:
   ```bash
   git checkout main && git pull origin main
   git branch -D release/vX.Y.Z
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

9. **Verify CI**: `gh run list --workflow "Build & Release"` — wait for completion

10. **Verify release assets**: `gh release view vX.Y.Z --json assets` — all 5 platforms present

## Version scheme

- **Patch** (X.Y.Z+1): bug fixes, security, docs — users should update
- **Minor** (X.Y+1.0): new features, new platforms
- **Major** (X+1.0.0): breaking changes (rare)

## Gotchas

- `npm version` updates both package.json and package-lock.json — always use it
- Use `sed` for Info.plist, never PlistBuddy (it reorders keys)
- `gh release create` needs `--notes-file` in non-interactive terminals
- Tag with `git tag -a` (annotated), bare `git tag` fails in dumb terminals
- After release, rebuild locally: `cd macapp && ./build.sh`
- `gh` defaults to upstream repo — always use `-R MrGameVlogger/jellyfin-mpv-play`
