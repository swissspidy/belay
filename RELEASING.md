# Releasing

`@swissspidy/belay-core`, `@swissspidy/belay-web` and `@swissspidy/belay-calibrate` are released
together, at the same version, with [Changesets](https://github.com/changesets/changesets) and
[`release.yml`](.github/workflows/release.yml).

## Every change

A pull request that changes a published package adds a changeset:

```sh
npx changeset
```

Pick the bump (while Belay is 0.x: `minor` for breaking changes and features, `patch` for fixes)
and write one line for the changelog. Commit the file it creates in `.changeset/`. Changes that
don't affect the packages (examples, docs, CI) don't need one.

## Every release

On each push to `main` with pending changesets, the release workflow opens or updates a
**Version packages** pull request. It bumps the versions and the `@swissspidy/belay-*` ranges
between the packages, and writes each package's `CHANGELOG.md`. The pull request is opened with the
workflow's token, so CI doesn't run on it; it only changes versions, changelogs and the lockfile.

Merge it when you want to release. The workflow then **stages** the new versions on npm, with
provenance, and pushes the tags and creates the GitHub releases. A staged version is not public
until you approve it with 2FA:

- on npmjs.com, under **Staged Packages**, or
- with `npm stage approve <stage-id>`. The release job's summary lists the stage IDs.

Approve all three packages, so they go live at the same version.

## How the release workflow runs

[`release.yml`](.github/workflows/release.yml) has three jobs, so that the only job that can publish
installs and runs nothing from the dependency tree:

1. `version` runs on every push to `main`. Changesets opens or updates the Version packages pull
   request; the job installs with `--ignore-scripts` and has no OIDC token. When `main`'s packages
   carry versions that are neither on npm nor tagged (that pull request was merged), the push is a
   release.
2. `pack` installs, builds, runs publint and packs each package. It has no OIDC token either.
3. `stage` is the only job with `id-token: write`, in the `npm` environment. It installs nothing:
   it stages the tarballs with `npm stage publish` (npm 11.15.0 or later, which the job checks),
   then tags each `name@version` and creates its GitHub release from the package's `CHANGELOG.md`.
   Tagged versions are skipped, so a run that failed partway can be re-run, and pushes to `main`
   while a staged version waits for approval don't stage it again. The job can't list stages (that
   needs a maintainer's login): if a run staged a version but failed before tagging it, approve or
   reject that stage before re-running.

Each package's trusted publisher on npm names this repository, `release.yml` and the `npm`
environment, and only needs to allow staged publishes. Provenance comes from
`publishConfig.provenance` in each package, which also means a `npm publish` from a laptop fails:
releases go through the workflow. Don't add required reviewers to the `npm` environment; the 2FA
approval on npm is the review step.

## Moving to an organization

The `belai` npm organization is reserved in case the packages move out of the user scope. Moving
means publishing under the new names (`@belai/core`, …), deprecating the old ones with
`npm deprecate @swissspidy/belay-core "Moved to @belai/core"`, and renaming the imports.
