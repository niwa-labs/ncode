# Source release

Publish the reviewed source commit on the Ncode fork. Run `pnpm verify`
from a clean checkout and check the source inventory and licenses in the export.
The `Source candidate` workflow can build and verify a source archive and
upload it as a GitHub Actions artifact.

## Publish the CLI to npm

Configure the GitHub Actions trusted publisher for `@niwa-labs/ncode` in the
npm package settings. Set the organization to `niwa-labs`, the repository to
`ncode`, and the workflow filename to `cli-release.yml`. Leave the environment
name blank. The publish job authenticates with GitHub OIDC using Node 24 and
npm 11.5.1 or later.

Prepare a reviewed commit on `main` with matching versions in the root and TUI
package manifests and entries in both TUI changelogs. Push a protected release
tag matching that version, such as `v0.4.13` or `v0.4.13-rc.1`. The tag push
starts `cli-release.yml`. The workflow checks the tag, version, and ancestry on
`main`, builds the archive, and tests isolated installations across the Linux
and macOS matrix.
After every installation check passes, the publish job downloads the same
`cli-package` artifact from the run, checks the archive name and SHA-256, and
publishes that archive with provenance and public access. Stable versions use
the `latest` dist-tag and prereleases use `next`.

Pull requests and workflow dispatches on branches perform build and
installation verification only. A dispatch with a release tag as the workflow
ref repeats a failed release run. After a tagged run succeeds, check the
registry with
`npm view @niwa-labs/ncode@latest version bin` or use `@next` for a prerelease.
The package installs one command, `ncode`.

## Check a local CLI archive

On Linux or macOS, build a test archive from a clean, committed checkout.
Use an unused output directory outside the repository.

```sh
export MCODE_RELEASE_TAG="v$(node -p 'require("./package.json").version')"
pnpm build
node scripts/package-cli-release.mjs "$MCODE_RELEASE_TAG" /tmp/mcode-release
MCODE_RELEASE_ARCHIVE="/tmp/mcode-release/ncode-${MCODE_RELEASE_TAG#v}.tar.gz" pnpm verify --profile package
```

The archive includes the CLI, runtime assets, licenses, and its source receipt.
The package check installs it in a temporary prefix and exercises the installed
CLI. Check the SHA-256 checksum and source revision when sharing an archive.

## What Actions verifies

Pushes to `main` run source verification and the release audit. The separate
`Python SDK package verification` workflow checks the Python build artifacts.
