# Pixlad

Pixlad pixelates faces and other areas in JPG photos, and does nothing else.

It exists because most editing software, like Photoshop, decodes and re-encodes the whole image to
hide one or a few faces. Pixlad edits the JPG directly instead, so it only changes the pixelated
areas. The EXIF, ICC profile and other metadata carry over.

It's also easier and faster to use than a general-purpose editor, and lets a photographer or editor
pixelate every face in a section of a crowd in a few seconds.

This is an early development version. Expect rough edges.

## Use

Drag and drop JPGs or folders on the window, draw over people to detect faces or draw a general
area, and export. Faces come from a small local model, so check every face before you export.
Sessions live in memory only. Pixlad writes the exported JPGs and a small `settings.json`, and
makes no network requests except the update check against GitHub.

## Packages

Download a package from the [Releases page](https://github.com/filipkauffeldt/pixlad/releases).
No builds are signed in a way that Microsoft or Apple trusts, so macOS and Windows warn you on first
launch. If you want to, you can always [build the app from source](#develop).

| System                          | File        | Install                                                     |
| ------------------------------- | ----------- | ----------------------------------------------------------- |
| macOS (Apple Silicon)           | `.dmg`      | Open it and drag Pixlad to Applications.                    |
| Windows (x64)                   | `.exe`      | Run the installer.                                          |
| Fedora, RHEL, openSUSE (x86_64) | `.rpm`      | `sudo dnf install ./pixlad-*.rpm`                           |
| Other Linux distros (x86_64)    | `.AppImage` | Download it, run `chmod +x pixlad-*.AppImage`, then run it. |

On Linux, pick the rpm for Fedora, RHEL and openSUSE. It adds a menu entry, you remove it with
`sudo dnf remove pixlad`, and updates ask for your password. Pick the AppImage for any other
distro. It adds no menu entry by itself, and updates need no password.

The AppImage does not need `libfuse2`. On a system with no FUSE at all, start it with
`APPIMAGE_EXTRACT_AND_RUN=1 ./pixlad-*.AppImage`.

Ubuntu 24.04 and later block the user namespaces that Chromium's sandbox uses. The AppImage still
starts there, but without the sandbox. To keep the sandbox, allow user namespaces for the whole
system with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. To keep that after a
reboot, put the line `kernel.apparmor_restrict_unprivileged_userns=0` in a file in
`/etc/sysctl.d/`.

## Updates

Pixlad checks GitHub for a newer release when it starts. Turn this off in Settings, or check by
hand in About.

- macOS downloads the dmg into Downloads and opens it. You drag the app to Applications again.
- Windows downloads the installer and runs it.
- The rpm installs through your package manager, which asks for your password.
- The AppImage replaces its own file and restarts, with no password. If the file name has a
  version, the new file carries the new version and the old file is gone.

## Develop

You need Node.js 24 and pnpm 12.

```sh
git clone https://github.com/filipkauffeldt/pixlad.git
cd pixlad
npm install --global pnpm@12.15.0
pnpm install
pnpm start
```

`pnpm dev` runs with live reload. `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:e2e`
check the code. `pnpm package` builds an installer into `dist/`.

## Licence

GPL-3.0-or-later, see [LICENSE](LICENSE). The retouch behaviour comes from
[editing-experiment](https://github.com/filipkauffeldt/editing-experiment). Licences for everything
that ships with the app, including the YuNet model, ONNX Runtime and the fonts, are in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) and [third_party/](third_party).
