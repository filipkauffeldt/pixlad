# Pixlad

Pixlad does one thing. You drop JPEG photos on it, pixelate faces and areas, and export JPEGs.
There is no library, no develop settings, no crop, resize or sharpening. Pixels outside the
mosaic stay exactly as they were.

This is an AI-developed proof of concept. Expect rough edges.

## What it does

1. **Open.** Drag JPEG files or folders anywhere on the window, or click **Open…** when it is
   empty. Dropping more adds to the session. The photos line up in a strip at the bottom, and the
   arrow keys step through them. The app refuses files that are not JPEGs and names them in a
   message. It also refuses CMYK JPEGs, because editing one would change its colours. A dropped
   folder adds the JPEGs directly in it, not those in its subfolders.
2. **Retouch.** The toolbar has `Faces · Rectangle · Lasso`, `Add · Subtract`, block size, face
   padding and Undo. You can drag the block size slider or type a value. Blocks are never smaller
   than 8 px, and no shape gets more than 8 blocks across its short side.
   - _Faces_ finds faces in a dragged rectangle. Hold `Alt` while dragging to search inside a lasso
     instead. With _Subtract_, dragging removes the faces in that area without running a search.
   - Click an area or a face to switch it on or off.
   - A drag may start just outside the photo. The app clips it to the photo.
   - `Z` toggles Fit and 100%. `Ctrl`/`⌘` + `+` / `-` and `Ctrl`/`⌘` + scroll zoom. Scroll or
     `Space` + drag pans. At 100% the photo lines up with the screen's pixel grid.
3. **Export.** `Export` (`Ctrl`/`⌘`+`E`) saves the current photo, and `Export all` saves every
   photo with a mosaic. See [Where exports go](#where-exports-go). Afterwards the app asks whether
   to remove the exported photos from the session. It leaves out any photo you edited after its
   export started, and removing a photo never deletes its file.

Face detection uses the YuNet model (see [Third-party](#third-party)). **Settings** holds the
export target, the update check and a link to **About**. About shows the version, a button to
check for updates, the copyright, the licence, a link to the source code and every third-party
part with its licence text.

## Sessions

A session lives in memory and disappears when the app closes.

- The app saves nothing about it. There is no library, database, recent files list, saved areas,
  sidecars or thumbnail cache. The window uses an in-memory Chromium profile, and the app never
  copies photos. It writes two kinds of file only, the exported JPEGs and `settings.json` in its
  data folder. That file holds the export setting and the update setting, and nothing about the
  photos. The one exception is an update you ask for, which saves the installer (see
  [Updates](#updates)).
- Hundreds of photos are fine. Dropping reads only each file's header, and the app decodes only
  the current photo, in one worker thread. Thumbnails come from each photo's DC coefficients when
  they scroll into view, and the app keeps a small number of recent ones in memory. The strip only
  creates elements for what is on screen. The app adds files in chunks, so the window stays
  responsive.
- Removing a photo from the session, with the `×` on its thumbnail or `Delete`, never touches the
  file.
- If mosaics are not exported when you close the window, the app asks once, for example
  `3 photos have unexported mosaics. Close anyway?`
- **Export all** exports every photo with at least one enabled mosaic area and skips the rest. It
  ends with a count such as `12 exported, 3 failed` and names the photos that failed. One failure
  does not stop the others. It runs in the background with progress in the strip, so you can keep
  working. Each photo exports what was on screen when its own export started.

## Where exports go

There are two choices. The first export asks which one to use, in a small popover under the
Export button that shows the file name it will write or replace. The app remembers the answer
between runs, and **Settings → Export** changes it later.

**New copy** is the default. The export goes next to the source as
`<source name>_edit.jpg`, and the extension keeps its case, so `_DSC1234.JPG` becomes
`_DSC1234_edit.JPG`. There is no export folder to choose.

- The app never overwrites an existing file, whether it came from an earlier session or anywhere
  else. It uses `_edit-2`, `_edit-3` and so on instead.
- Exporting the same photo again in one session replaces the file that session wrote, as long as
  that file is unchanged. The app checks its path, size and modification time, which it keeps in
  memory only.
- A source named `*_edit.jpg` is an ordinary source. Its export is `x_edit_edit.jpg`.
- The app never writes to the source. It writes a temporary file in the same folder and renames it
  into place. If the folder is read-only, that photo fails with a message naming the folder, and
  nothing is written anywhere else.

**Replace original** replaces the source file with the export. You cannot undo this.

- The app writes and checks the new file first, then renames it over the source. A failed export
  leaves the source as it was. The app refuses to overwrite a read-only file.
- Afterwards the mosaic is part of the photo. The app clears its areas and Undo history and loads
  the file again from disk.

## How colours are handled

The app never converts colour. There is no sRGB conversion and no gamma or linear-light step.

- The mosaic averages the decoded values exactly as the file stores them, with JFIF YCbCr to RGB
  and nothing else.
- The export keeps the source's ICC profile byte for byte by copying its APP2 chunks unchanged.
  The app checks this on the written file before saving it.
- The photo on screen is the original file, shown by Chromium as an `<img>`. Chromium
  colour-manages an `<img>` with an embedded profile and converts it to the display. Raw pixel
  data, such as a canvas or an image without a profile, counts as sRGB. Drawing decoded pixels on
  a canvas would therefore show a wide-gamut photo with the wrong colours. The mosaic preview is
  a PNG that carries the photo's own ICC profile and sits on top of it. Chromium applies the same
  profile to both, so Adobe RGB and Display P3 photos look the same in the app as in any viewer
  that opens the exported file.

## How JPEG quality is kept

The export does not decode and re-encode the whole image. It works on the JPEG's quantized DCT
coefficients, so everything outside the mosaic stays bit-identical.

1. The app decodes the source's entropy-coded data to coefficients. It handles baseline, extended
   sequential and progressive Huffman JPEGs with 4:2:0, 4:2:2 or 4:4:4 subsampling, and grayscale.
2. It computes the mosaic on the decoded pixels. Only the 8×8 blocks that contain mosaic pixels
   go through the DCT and quantization again, with the source's own quantization tables. Every
   other block keeps its coefficients.
3. It writes the coefficients back with the source's quantization tables and subsampling, using
   optimized Huffman tables in one baseline scan. A progressive source becomes baseline.

The table below compares the result with a full re-encode. The photo is a public-domain 3840×3017
image (`apollo11_crew.jpg`, 11.6 MP, 4:2:0) with a mosaic over a rectangle covering 12% of it.
`test/measure.test.ts` produces the numbers, using libjpeg-turbo to decode both files.

| Region                                                      | Pixels     | Max diff | Mean diff |
| ----------------------------------------------------------- | ---------- | -------- | --------- |
| Lossless export, more than 17 px from the mosaic            | 10,112,268 | 0        | 0         |
| Lossless export, unmasked pixels within 17 px of the mosaic | 82,548     | 25       | 0.23      |
| Full decode and re-encode at q95, for comparison            | 10,194,816 | 25       | 0.23      |

The re-encode's 0.23 mean covers every unmasked pixel in the picture. The lossless export's 0.23
covers only the thin ring beside the mosaic, and everywhere else the export is identical. The
exported file is 1,334,360 bytes, against 1,573,314 for the source, thanks to the optimized
Huffman tables.

Pixels in a rewritten block that are not mosaic themselves can still change a little, as the
table shows. Chroma subsampling also means a block's neighbours can pick up a small colour change
at the mosaic's edge.

## Metadata and previews

The export copies EXIF, IPTC, XMP, the ICC profile, comments and the Adobe marker unchanged from
the source, including the capture time and the Orientation tag. The app never rotates pixels, so
the Orientation tag stays valid and nothing gets rotated twice. The exported file gets the
source's modification time.

**An export never contains a thumbnail or preview of the unretouched photo.** The app removes the
EXIF thumbnail (IFD1 and its data), preview tags, any JPEG stream inside EXIF, the JFIF
thumbnail, Photoshop thumbnail resources, XMP thumbnail properties, MPF and any data after the
EOI marker. JPEG streams inside maker notes are zeroed in place. It drops every other APPn
segment, because it cannot prove such a segment is free of a preview. Before renaming the file
into place, the app checks the written bytes against an allowlist ported from editing-experiment.
If the check fails, it deletes the temporary file and that photo's export fails with the reason.

## Packages

The [Releases page](https://github.com/filipkauffeldt/pixlad/releases) is the place to download
Pixlad. Each release has one package for each system below, and the newest one is marked Latest.

| System               | Package               | File on the Releases page           |
| -------------------- | --------------------- | ----------------------------------- |
| macOS, Apple Silicon | `.dmg`                | `pixlad-<version>-mac-arm64.dmg`    |
| Windows, x64         | NSIS installer `.exe` | `pixlad-<version>-win-x64.exe`      |
| Fedora, x64          | `.rpm`                | `pixlad-<version>-linux-x86_64.rpm` |

The other files on a release are for the updater. They are the `latest*.yml` files and the
`.blockmap` files.

None of the packages is signed with a certificate, so macOS and Windows warn you the first time
you open the app. Each package holds the app, the face model, the licence texts and the ONNX
Runtime library for its own system.

### Test builds

A GitHub Actions workflow also builds the same packages on every pull request and every push to
`main`, and you can start it by hand from the Actions tab. These are test builds. They have the
version `0.0.0-dev.g<short commit sha>`, so each commit has its own. They never check for
updates, and the workflow creates no releases or tags.

| System               | Artifact name                  |
| -------------------- | ------------------------------ |
| macOS, Apple Silicon | `pixlad-macos-arm64-dmg`       |
| Windows, x64         | `pixlad-windows-x64-installer` |
| Fedora, x64          | `pixlad-fedora-x64-rpm`        |

To download a test build, open the workflow run in the repository's Actions tab. For a pull
request, select Details on the Package check. The artifacts are listed at the bottom of the run
page. GitHub serves each one as a zip file and asks you to sign in.

### macOS

The app has an ad-hoc signature and no notarization, so macOS blocks it the first time.

1. Open the `.dmg` and drag Pixlad to Applications.
2. Open Pixlad from Applications. macOS says it cannot verify the app. Select Done.
3. Open System Settings → Privacy & Security and scroll down to Security.
4. Select Open Anyway next to the message that Pixlad was blocked. Enter your password or use
   Touch ID.
5. Select Open in the dialog that follows. Later starts open normally.

### Windows

Run the installer. SmartScreen shows "Windows protected your PC". Select More info, then Run
anyway.

### Fedora

```sh
sudo dnf install ./<file>.rpm
```

Start Pixlad from the application menu, or run `pixlad` in a terminal.

### Building a package yourself

Run `pnpm install` and then `pnpm package` on the system you want a package for. The package ends
up in `dist/`. It has the placeholder version `0.0.0-dev` and never checks for updates. Building the rpm needs `rpmbuild`, which Fedora ships in `rpm-build` and Debian and
Ubuntu in `rpm`. `pnpm test:package` starts the app that `pnpm package` left in `dist/`, drops a
photo on it, exports, runs face detection and opens About. On Linux without a display, run it as
`xvfb-run -a pnpm test:package`.

## Cutting a release

Releases are cut by hand from GitHub Actions.

1. Open the Actions tab, select Release and select Run workflow on `main`.
2. Choose the bump: `patch`, `minor` or `major`.

The workflow works out the next version from the highest `vX.Y.Z` tag. The first release is
`v0.1.0` whatever the bump. It then tags the current `main` commit and creates a draft release
named `Pixlad X.Y.Z` with GitHub's generated notes. The macOS, Windows and Fedora jobs build from
the tag. Each one uploads its installer, its blockmap and its updater file to the draft. The
Fedora job has no blockmap, because electron-builder writes none for an rpm. When all three jobs
pass, the workflow publishes the draft and marks it Latest.

If any job fails, a last job deletes the draft and the tag, so nothing is half released. Start the
workflow again after fixing the cause. A release that is already public is never deleted. The
workflow runs from `main` only, and only one release runs at a time.

You can also start it from a terminal:

```sh
gh workflow run release.yml -f bump=minor
```

## Versions

Pixlad stays on 0.x while it is a proof of concept. A minor bump adds features and a patch bump
fixes bugs. The version becomes 1.0.0 when the app is ready to hand out.

The release tag is the only source of the version. It goes to electron-builder, so the installer
names, `app.getVersion()` in the packaged app, the updater files and the version in About all
match. `package.json` keeps the placeholder `0.0.0-dev`. An app run from source shows
"Version dev" in About.

## Updates

On start, the app asks GitHub whether a newer release exists, as long as the setting is on and
the app is a packaged release build. It then shows "Pixlad 0.3.0 is available." with Update and
Later. Prereleases are never offered. The About dialog has a Check for updates button that shows
the result in place: "Pixlad is up to date", the available version with Update, or the reason the
check failed. A failed check at start says nothing and only writes a console warning.

- On Windows, Update downloads the installer with progress. Restart to update then closes the
  app, runs the installer and starts Pixlad again. The app uses electron-updater for this.
- On Fedora, Update downloads the rpm with progress, and Restart to update installs it with dnf
  and starts Pixlad again. electron-updater asks for administrator rights with `pkexec`, or with
  `sudo` when `pkexec` is missing. The rpm is not signed, so dnf installs it without a signature
  check.
- On macOS, the app is not signed with a certificate, so macOS cannot install an update for it.
  Update downloads the `.dmg` into your Downloads folder with progress and opens it. Replace
  Pixlad in Applications as you did for the first install.

**Settings → Updates → Check for updates on start** turns the check at start on or off. It is on
by default, and the app remembers the choice in `settings.json`. Test builds from Actions and
apps run from source never check for updates.

The only network requests the app makes go to GitHub, for the release information and the
installer. The app has no telemetry.

## Prerequisites

- [Node.js](https://nodejs.org) 24
- [pnpm](https://pnpm.io) 12 (`npm install --global pnpm@12.15.0`)
- Git

No system packages are needed. `pnpm install` downloads the face model and checks its SHA-256.
The first `pnpm start` downloads Electron.

## Install and run from source

**Linux**

```sh
git clone https://github.com/filipkauffeldt/pixlad.git
cd pixlad
npm install --global pnpm@12.15.0
pnpm install
pnpm start
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/filipkauffeldt/pixlad.git
cd pixlad
npm install --global pnpm@12.15.0
pnpm install
pnpm start
```

`pnpm start` builds the app and opens it. On Linux, Electron stops with a message about
`chrome-sandbox` unless root has set up that helper, and the message explains how.
`pnpm start:no-sandbox` runs without Chromium's sandbox instead. `pnpm dev` runs the app with live
reload. If the face model failed to download during install, run `pnpm fetch-model`. Everything
except Faces works without it.

The other commands are `pnpm lint`, `pnpm typecheck`, `pnpm test` for unit tests and
`pnpm test:e2e` for Playwright tests against the built app. On Linux without a display, run
`xvfb-run -a pnpm test:e2e`. `pnpm fetch-fixtures` downloads one public-domain photo for the face
detection tests, which skip without it. The tests generate every other fixture, and the repo
contains no photos.

To take screenshots, run
`SCREENSHOT_DIR=/abs/folder xvfb-run -a pnpm vitest run --config vitest.e2e.config.ts test/e2e/screenshots.e2e.test.ts`.

The icon's source is `build/icon.svg`. After changing it, run `pnpm render-icon` and commit both
files.

## Keyboard

Shortcuts match the character a key types (`event.key`), so they work on a Swedish layout. No
shortcut uses an AltGr symbol, and `Alt` or AltGr alone never runs a command. `Alt` only changes
a drawing, either to the Faces lasso or by flipping Add and Subtract.

| Key                                    | Action                  |
| -------------------------------------- | ----------------------- |
| `←` `→`                                | previous / next photo   |
| `Ctrl`/`⌘` + `Z`                       | Undo                    |
| `Ctrl`/`⌘` + `E`                       | Export this photo       |
| `Z`                                    | Fit ↔ 100%              |
| `Ctrl`/`⌘` + `+` / `-`, `Ctrl` + wheel | zoom                    |
| `Space` + drag, wheel                  | pan                     |
| `Delete`                               | remove from the session |

## Known limits

- It is a proof of concept.
- It supports 8-bit baseline and progressive Huffman JPEGs in YCbCr or grayscale. It refuses
  CMYK and YCCK, arithmetic-coded, 12-bit, lossless and hierarchical JPEGs, and JPEGs that store
  RGB directly, with a message for each.
- Face detection is only as good as YuNet. Check every face before exporting. The model can miss
  small, turned or covered faces, so use Rectangle or Lasso for those.
- The app decodes only the current photo, but a very large photo still needs a few hundred MB
  while it is open. During an export, its coefficients need memory too.
- Exports always use one baseline scan with optimized tables and no restart markers.
- The export drops extended XMP that carries a thumbnail, along with other unknown metadata
  blocks.
- The preview shows the mosaic of the decoded pixels. The export also quantizes the touched
  blocks, so it can differ from the preview by a level or two.
- Dropping a large number of files from a slow disk takes time to list, but the window stays
  usable.

## Where the code came from

The retouch behaviour comes from the
[editing-experiment](https://github.com/filipkauffeldt/editing-experiment) project. That covers
areas, face padding and detection, the mosaic, the drawing rules, zoom and pan maths, the preview
allowlist and the look. editing-experiment is GPL-3.0-or-later, and so is Pixlad (see
[LICENSE](LICENSE)). The JPEG codec, the export and the session handling are new.

## Licence

Copyright (C) 2026 Filip Kauffeldt. Pixlad is free software under the GNU General Public License,
version 3 or later ([LICENSE](LICENSE)). Every source file has an SPDX header.

[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) holds the licence text of everything else that
ships with the app. `pnpm notices` regenerates it from the installed production dependencies. CI
runs `pnpm notices:check`, which fails if the file is out of date, if a dependency has no licence
text, or if a licence is not on the GPL-compatible list in `scripts/third-party-notices.ts`.
[third_party/](third_party) holds the licence texts that npm packages leave out.

## Third-party

- **YuNet** face detection model, `face_detection_yunet_2026may.onnx`, from the
  [OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet). MIT
  licence, Copyright (c) 2020 Shiqi Yu. The licence text is in
  [third_party/yunet/LICENSE](third_party/yunet/LICENSE). `pnpm install` downloads the model, and
  the repo does not include it.
- **ONNX Runtime** (MIT, Microsoft). The notices for the components in its native library are in
  [third_party/onnxruntime/](third_party/onnxruntime).
- **Inter** and **JetBrains Mono** (SIL OFL 1.1), from `@fontsource-variable`. Their licences are
  in [third_party/fonts/](third_party/fonts).
- This software is based in part on the work of the Independent JPEG Group. The progressive JPEG
  decoding follows libjpeg's algorithms ([third_party/libjpeg/](third_party/libjpeg)).
- Electron (MIT, and Chromium's licences ship with it), React (MIT) and electron-updater (MIT)
  run in the app. Playwright,
  Vitest, sharp and exiftool-vendored are dev-only. The tests use sharp and exiftool-vendored as
  independent references. The lint and build tooling is dev-only too.
