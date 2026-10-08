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
between the packages, and writes each package's `CHANGELOG.md`. Merge it when you want to release: the
workflow then publishes the new versions to npm (with provenance), pushes the tags and creates
the GitHub releases.

The Version packages pull request is opened with the workflow's token, so CI doesn't run on it.
It only changes versions, changelogs and the lockfile.

The workflow runs in the `npm` GitHub environment, which GitHub creates on its first run. Don't
add required reviewers to it: the job runs on every push to `main`, so each push would wait for
an approval.

## Moving to an organization

The `belai` npm organization is reserved in case the packages move out of the user scope. Moving
means publishing under the new names (`@belai/core`, …), deprecating the old ones with
`npm deprecate @swissspidy/belay-core "Moved to @belai/core"`, and renaming the imports.
