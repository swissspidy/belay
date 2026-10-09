# Changesets

Each pull request that changes a published package (`@swissspidy/belay-core`, `@swissspidy/belay-web`,
`@swissspidy/belay-calibrate`) adds a changeset: run `npx changeset`, pick the bump, and write one line for
the changelog. The three packages are released together at the same version. Merging the Version
packages pull request stages the release on npm, where a maintainer approves it with 2FA. See
[RELEASING.md](../RELEASING.md).
