# GitHub workflows

This directory contains the repository's contribution templates, CI workflow,
and GitHub Release automation.

## Branch roles

- `main` mirrors the original project's `upstream/main` branch. Do not merge
  fork-specific changes into it.
- `fork-main` is the integration and release branch for this fork.
- Feature, fix, and release branches target `fork-main` through pull requests.

The expected upstream synchronization flow is:

```text
upstream/main -> main -> fork-main
```

## Continuous integration

The CI workflow runs for pull requests targeting `fork-main` and pushes to
`fork-main`. It verifies the project on Node.js 22 and 24 by running:

```bash
npm ci
npm run lint
npm run test:unit
npm pack --dry-run
npm run release:check-version
```

Network-backed Pine compilation tests are disabled by default. Run them
explicitly when network access is available:

```bash
TV_RUN_NETWORK_TESTS=1 npm run test:unit
```

## Version source

`package.json` is the authoritative version source. `package-lock.json`, the
`tv --version` output, and the MCP server version must resolve to the same
value.

Check the current version state with:

```bash
npm run release:check-version
npm run --silent release:print-tag
tv --version
```

Versions follow Semantic Versioning:

- Patch (`1.0.0` -> `1.0.1`): backward-compatible fixes.
- Minor (`1.0.0` -> `1.1.0`): backward-compatible features.
- Major (`1.0.0` -> `2.0.0`): breaking changes.

## Prepare a release

Create a release branch from the latest `fork-main`:

```bash
git switch fork-main
git pull --ff-only origin fork-main
git switch -c release/v1.1.0
```

Update `package.json` and `package-lock.json` without creating a local Git tag:

```bash
npm version 1.1.0 --no-git-tag-version
```

Validate the release locally:

```bash
npm run release:check-version
npm run lint
npm run test:unit
npm pack --dry-run
```

Commit and push the release branch:

```bash
git add package.json package-lock.json
git commit -m "chore: release v1.1.0"
git push -u origin release/v1.1.0
```

Open a pull request with this target:

```text
release/v1.1.0 -> fork-main
```

Do not create the version tag manually. CI must pass before the release pull
request is merged.

## Publish a release

The Release workflow runs when a merged pull request to `fork-main` changes
`package.json`. It performs the following steps:

1. Checks out the pull request's merge commit.
2. Verifies that package and lockfile versions are synchronized.
3. Derives the `vX.Y.Z` tag from `package.json`.
4. Checks the remote tag and GitHub Release state.
5. Creates an annotated tag on the merge commit when it does not exist.
6. Creates a GitHub Release with generated release notes.

The workflow can also be started with `workflow_dispatch`. When starting it
manually, select the intended `fork-main` commit or branch.

## Rerun and failure behavior

- If the tag and GitHub Release already exist on the same commit, the workflow
  exits without replacing them.
- If the tag exists but the GitHub Release does not, the workflow creates the
  missing release.
- If the version tag points to a different commit, the workflow fails and does
  not move the tag.
- The workflow does not publish to npm. npm publication requires separate
  package ownership and registry credential configuration.
