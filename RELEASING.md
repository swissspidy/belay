# Releasing

`@swissspidy/belay-core`, `@swissspidy/belay-web` and `@swissspidy/belay-calibrate` are released together, at the same version,
with [Changesets](https://github.com/changesets/changesets) and
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
**Version packages** pull request. It bumps the versions and the `@swissspidy/belay-*` ranges between the
packages, and writes each package's `CHANGELOG.md`. Merge it when you want to release: the
workflow then publishes the new versions to npm (with provenance), pushes the tags and creates
the GitHub releases.

The Version packages pull request is opened with the workflow's token, so CI doesn't run on it.
It only changes versions, changelogs and the lockfile.

## One-time setup

Do this before merging the pull request that adds the release workflow. The workflow's first run
on `main` tries to publish 0.1.0, and fails until these steps are done.

1. **Create the `belay` npm organization** (free for public packages): `npm org create belay`,
   or on npmjs.com under *Add Organization*.
2. **Publish 0.1.0 by hand.** npm can only configure trusted publishing for a package that
   exists. With an account that has 2FA and is a member of the org:

   ```sh
   npm ci
   npm run check
   npm publish --workspace packages/core
   npm publish --workspace packages/web
   npm publish --workspace packages/calibrate
   ```

3. **Add a trusted publisher to each package** on npmjs.com (*Settings → Trusted publishing →
   GitHub Actions*): organization `swissspidy`, repository `belay`, workflow `release.yml`,
   environment `npm`.
4. **Let the workflow open pull requests:** in the GitHub repository settings, under *Actions →
   General → Workflow permissions*, check *Allow GitHub Actions to create and approve pull
   requests*.
5. Optionally, in each package's npm settings, set publishing access to *Require two-factor
   authentication and disallow tokens*, so only the workflow can publish.

The workflow runs in the `npm` GitHub environment, which GitHub creates on its first run. Don't
add required reviewers to it: the job runs on every push to `main`, so each push would wait for
an approval.
