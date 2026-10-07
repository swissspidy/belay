# Releasing

`@belay/core`, `@belay/web` and `@belay/calibrate` are released together, at the same version.
Pushing a `v<version>` tag runs [`release.yml`](.github/workflows/release.yml), which checks that
the tag matches the package versions, runs `npm run check`, and publishes the three packages with
npm trusted publishing (no npm token; provenance is added automatically).

## One-time setup

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

   Then tag that commit `v0.1.0` and push the tag. The release workflow skips versions that are
   already on npm, so this run only checks the build.
3. **Add a trusted publisher to each package** on npmjs.com (*Settings → Trusted publishing →
   GitHub Actions*): organization `swissspidy`, repository `belay`, workflow `release.yml`,
   environment `npm`.
4. **Create the `npm` environment** in the GitHub repository settings (*Environments*). Optionally
   add yourself as a required reviewer, so every publish waits for an approval.
5. Optionally, in each package's npm settings, set publishing access to *Require two-factor
   authentication and disallow tokens*, so only the workflow can publish.

## Every release

```sh
git checkout main && git pull
npm run set-version -- 0.2.0   # all three packages and the @belay/* ranges between them
npm install                    # updates package-lock.json
npm run check
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

Then write the release notes on GitHub from the tag.
