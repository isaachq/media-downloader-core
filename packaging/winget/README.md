# winget

`node scripts/winget-manifests.mjs app-v<version>` writes the three manifests
of a release here (`<version>/`), with the installer urls and SHA-256 taken
from the GitHub release. The `winget manifests` workflow does the same for
every published release, checks them against Microsoft's schemas and keeps
them as an artifact. They are submitted as a pull request to
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) under
`manifests/i/isaachq/MediaDownloadCore/<version>/`.
