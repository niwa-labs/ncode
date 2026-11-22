# Source release

Publish the reviewed source commit on the Ncode fork. Run `pnpm verify`
from a clean checkout and check the source inventory and licenses in the export.
The `Source candidate` workflow can build and verify a source archive and
upload it as a GitHub Actions artifact. For npm, build the CLI archive below, verify it, and publish that exact archive with `npm publish ./ncode-X.Y.Z.tar.gz --access public` from its output directory.

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

Pushes to `main` run source verification and the release audit. The `Ncode package verification` workflow builds an archive and tests isolated installations on Linux and macOS. The separate `Python SDK package verification` workflow checks the Python build artifacts. To publish Ncode, use the verified archive and the Niwa Labs npm scope. Check the registry after publication with `npm view @niwa-labs/ncode@latest version bin`. The package installs one command, `ncode`.
