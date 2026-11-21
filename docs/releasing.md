# Source release

Publish the reviewed source commit on the Ncode fork. Run `pnpm verify`
from a clean checkout and check the source inventory and licenses in the export.
The `Source candidate` workflow can build and verify a source archive and
upload it as a GitHub Actions artifact. The fork builds and updates from source.

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

## Upstream distribution

MiniMax maintains the official CLI installers, npm launcher and Python
packages. The fork's workflows restrict those publication steps to the
upstream repository. See the
[upstream release process](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/releasing.md).
