## Overview

Dependabot opens weekly version-update PRs for npm and GitHub Actions against `develop`, grouping minor and patch bumps into one PR per ecosystem. Patch and minor PRs merge themselves once CI passes; major bumps wait for a human.

## Current solution

- `.github/dependabot.yml` sets `target-branch: develop` and the minor/patch groups.
- `.github/workflows/dependabot-auto-merge.yml` runs on Dependabot PRs into `develop`, reads the update type with `dependabot/fetch-metadata`, and enables `gh pr merge --auto --squash` for anything that is not a semver major.
- Repository settings outside the code: "Allow auto-merge" is on, vulnerability alerts are on, and a ruleset named "Develop CI" requires the `check` job from `ci.yml` on `develop`. GitHub refuses to enable auto-merge on a branch with no required check, and without the requirement auto-merge would merge before CI finishes.

## Gotchas

- Security updates ignore `target-branch` and open against `main`. The workflow skips any PR whose base is not `develop`, so those are always merged by hand. Automatic security-update PRs are not enabled for that reason.
- The "Develop CI" ruleset also applies to direct pushes: a commit pushed straight to `develop` is rejected unless it already passed `check`. Land changes on `develop` through PRs.
- Do not turn on "Automatically delete head branches": merging any PR whose head is `develop` could then delete `develop`, which no ruleset protects from deletion.

## History

- 2026-10-22: Set up Dependabot with auto-merge for patch and minor updates.
