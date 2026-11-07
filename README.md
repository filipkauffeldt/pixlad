# Pixlad

A small desktop app that does one thing: drop JPEG photos on it, pixelate (mosaic) faces and
areas, and export JPEGs. There is no library, no develop settings, no crop, resize or sharpening.
Pixels outside the mosaic are left exactly as they were.

This is an AI-developed proof of concept. Expect rough edges.

## What it does

1. **Open.** Drag JPEG files (or folders) anywhere on the window, or use **Open…** when it is
   empty. Dropping more adds to the session. Several photos appear in a strip at the bottom; step
   through them with the arrow keys. Files that are not JPEGs are refused with a message that names
   them, and so are CMYK JPEGs (editing one would mean altering its colours). A dropped folder adds
   the JPEGs directly in it, not those in its subfolders.
2. **Retouch.** `Faces · Rectangle · Lasso`, `Add · Subtract`, block size in pixels (slider and
   typed field, never below 8 px, and a shape is never covered by more than 8 blocks across its short
   side), face padding, Undo.
   - _Faces_ finds faces in a dragged rectangle. Hold `Alt` while dragging to search inside a lasso.
     With _Subtract_, dragging removes the faces in that area (no search runs).
   - Click an area or a face to switch it on or off.
   - A drag may start just outside the photo; it is clipped to the photo.
   - Zoom: `Z` toggles Fit and 100%, `Ctrl`/`⌘` + `+` / `-`, `Ctrl`/`⌘` + scroll. Pan with scroll
     or `Space` + drag. 100% lines up with the device pixel grid.
3. **Export.** `Export` (`Ctrl`/`⌘`+`E`) saves the current photo; `Export all` saves every photo
   that has a mosaic. See [Where exports go](#where-exports-go). Afterwards the app asks whether to
   remove the exported photos from the session. A photo edited since its export is left out of
   that question, and removing never deletes a file.

Face detection uses the YuNet model (below). **Settings** holds the export target and **About**,
which shows the copyright, the licence, the source code link and every third-party part with its
licence text.

## Sessions

A session lives in memory and is gone when the app closes.

- Nothing about it is saved: no library, database, recent files, saved areas, sidecars or thumbnail
  cache. The window uses an in-memory Chromium profile, and photos are never copied. The only files
  the app writes are the exported JPEGs and `settings.json` in the app's data folder, which holds
  the export setting and nothing about the photos.
- **Any number of photos.** Hundreds are fine. Dropping reads only each file's header. Only the
  current photo is decoded (one worker thread holds its pixels); thumbnails are made when they come
  into view, from the photo's DC coefficients, and a small number of recent ones is kept in memory.
  The strip only creates elements for what is on screen. Adding is done in chunks, so the window
  does not freeze.
- **Removing a photo** from the session (the `×` on a thumbnail, or `Delete`) never touches the file.
- **Closing with mosaics not exported** asks once, e.g. `3 photos have unexported mosaics. Close
anyway?`
- **Export all** exports every photo with at least one enabled mosaic area, skips the others, and
  ends with a count such as `12 exported, 3 failed`; the failures are named. One failure does not stop
  the rest. It runs in the background, with progress in the strip, so you can keep working. Each
  photo is exported from what is on screen at the moment its export starts.

## Where exports go

**Settings → Export** chooses between two targets, and the choice is remembered between runs.

**Add `_edit` to the file name** is the default. The export goes next to the source, named
`<source name>_edit.jpg`, keeping the extension's case: `_DSC1234.JPG` becomes `_DSC1234_edit.JPG`.
There is no export folder to choose.

- A file that already exists (from an earlier session, or anything else) is never overwritten: the
  export is `_edit-2`, `_edit-3`, …
- Exporting the same photo again in the same session replaces the file this session wrote earlier,
  as long as it is still that file (same path, size and modification time; remembered in memory only).
- A source that is itself named `*_edit.jpg` is an ordinary source (`x_edit_edit.jpg`).
- The source is never written to. Export writes a temporary file in the same folder and renames it
  into place. If the folder is read-only, that photo fails with a message naming the folder; nothing
  is written elsewhere.

**Overwrite the original** replaces the source file with the export. This cannot be undone.

- The new file is written and verified first and then renamed over the source, so a failed export
  leaves the source as it was. A read-only file is refused.
- The mosaic is now part of the photo: its areas and Undo history are cleared, and the file is
  loaded again from disk.

## How the colours are handled

Colour is never converted. There is no sRGB conversion, no gamma or linear-light step.

- **Mosaic values** are averaged on the decoded values exactly as the file stores them (JFIF
  YCbCr to RGB, nothing else).
- **Export** keeps the source's ICC profile byte for byte (the APP2 chunks are copied unchanged),
  and the file is verified for this before it is saved.
- **Display.** The photo on screen is the original file shown by Chromium as an `<img>`. Chromium
  colour-manages an `<img>` with an embedded profile (it converts to the display), while raw pixel
  data (a canvas `getImageData`, or an image without a profile) is treated as sRGB, so drawing
  decoded pixels on a canvas would show a wide-gamut photo with the wrong colours. To keep the screen
  and the export in agreement, the mosaic preview is a PNG that carries the **same ICC profile** as
  the photo, laid over it. Chromium applies the profile to both in the same way, so Adobe RGB or Display
  P3 photos look the same in the app as in any viewer opening the exported file.

## How JPEG quality is kept

The export does **not** decode and re-encode the whole image. It works on the JPEG's quantized DCT
coefficients, so everything outside the mosaic is bit-identical:

1. The source's entropy-coded data is decoded to coefficients (baseline, extended sequential and
   progressive Huffman; 4:2:0, 4:2:2, 4:4:4 and grayscale).
2. The mosaic is computed on the decoded pixels. Only the 8×8 blocks that contain mosaic pixels are
   transformed and quantized again, with the source's own quantization tables. Every other block keeps
   its coefficients.
3. The coefficients are written back with the source's quantization tables, its subsampling and
   optimized Huffman tables, in one baseline scan. A progressive source becomes baseline.

Measured on a public-domain 3840×3017 photo (`apollo11_crew.jpg`, 11.6 MP, 4:2:0), mosaic over a
rectangle covering 12% of the picture (`test/measure.test.ts`; decoded with libjpeg-turbo for the
comparison):

| Region                                                      | Pixels     | Max diff | Mean diff |
| ----------------------------------------------------------- | ---------- | -------- | --------- |
| Lossless export, away from the mosaic (beyond 17 px)        | 10,112,268 | 0        | 0         |
| Lossless export, unmasked pixels within 17 px of the mosaic | 82,548     | 25       | 0.23      |
| For comparison: decode and re-encode everything at q95      | 10,194,816 | 25       | 0.23      |

The 0.23 mean is over every unmasked pixel of the picture for the re-encode, but only over the thin
ring beside the mosaic for the lossless export; everywhere else the lossless export is identical. File
size 1,334,360 bytes against the 1,573,314 byte source (optimized Huffman tables).

Limits: pixels in a rewritten block that are not themselves mosaic can differ slightly (the table
above), and chroma subsampling means a block's neighbours can see a small change in colour at the
mosaic's edge.

## Metadata and previews

EXIF, IPTC, XMP, the ICC profile, comments and the Adobe marker are copied from the source
unchanged, including capture time and Orientation. Pixels are never rotated, so the Orientation tag
stays and nothing is rotated twice. The file's modification time is set to the source's.

**An export never contains a thumbnail or preview of the unretouched photo.** Removed: the EXIF
thumbnail (IFD1 and its data), preview tags and any JPEG stream inside EXIF (maker notes; zeroed in
place), the JFIF thumbnail, Photoshop thumbnail resources, XMP thumbnail properties, MPF, and any
data after the EOI marker. Every other APPn segment is dropped, because it cannot be shown to be free
of a preview. Before the file is renamed into place, the written bytes are checked against an
allowlist (ported from the source project); if that fails the temporary file is deleted and the
photo's export fails with the reason.

## Prerequisites

- [Node.js](https://nodejs.org) 24
- [pnpm](https://pnpm.io) 12 (`npm install --global pnpm@12.15.0`)
- Git

No system packages are needed. `pnpm install` downloads the face model (MIT licence, checked against
a SHA-256), and the first `pnpm start` downloads Electron.

## Install and run

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

`pnpm start` builds the app and opens it. On Linux, Electron aborts with a message about
`chrome-sandbox` unless that helper is set up as root (the message says how); `pnpm start:no-sandbox`
runs without Chromium's sandbox instead. `pnpm dev` runs it with live reload. If the face model
could not be downloaded during install, run `pnpm fetch-model`; everything except Faces works
without it.

Other commands: `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit tests) and `pnpm test:e2e`
(Playwright against the built app; on Linux without a display run it as `xvfb-run -a pnpm test:e2e`).
`pnpm fetch-fixtures` downloads one public-domain photo for the face-detection tests (they skip
without it). All other fixtures are generated by the tests, and no photo is committed.

Screenshots: `SCREENSHOT_DIR=/abs/folder xvfb-run -a pnpm vitest run --config vitest.e2e.config.ts test/e2e/screenshots.e2e.test.ts`.

## Keyboard

Keys are matched by what they print (`event.key`), so they work on a Swedish layout. No shortcut
uses an AltGr symbol, and `Alt`/AltGr never triggers a command by itself (`Alt` only flips a drawing:
the Faces lasso, or Add/Subtract).

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

- A proof of concept; it has no packaged installer. It is started from the source tree.
- Supported: 8-bit baseline and progressive Huffman JPEGs, YCbCr or grayscale. Refused with a
  message: CMYK/YCCK, arithmetic-coded, 12-bit, lossless/hierarchical, and JPEGs that store RGB
  directly.
- Face detection quality is whatever YuNet gives; check every face before exporting. The model
  can miss small, turned or covered faces, so use Rectangle or Lasso for those.
- Only the current photo is decoded, but a very large photo needs a few hundred MB while it is open
  (its decoded pixels, and during export its coefficients as well).
- Exports always have a baseline scan with optimized tables and no restart markers.
- Extended XMP that carries a thumbnail is dropped; other unknown metadata blocks are dropped too.
- The mosaic preview is the mosaic of the decoded pixels; the export additionally goes through the
  JPEG quantization of the touched blocks, so it can differ from the preview by a level or two.
- Large drops of files on a slow disk take time to list; the window stays usable.

## Where the code came from

The retouch behaviour (areas, face padding and detection, mosaic, the Retouch tool's drawing rules,
zoom and pan maths, the preview allowlist, and the look) is adapted from the
[editing-experiment](https://github.com/filipkauffeldt/editing-experiment) project, which is
GPL-3.0-or-later; so is this one (see [LICENSE](LICENSE)). The JPEG codec, the export and the session
handling are new.

## Licence

Copyright (C) 2026 Filip Kauffeldt. Pixlad is free software under the GNU General Public
License, version 3 or later ([LICENSE](LICENSE)). Every source file carries an SPDX header.

[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) holds the licence text of everything else that
ships with the app. `pnpm notices` regenerates it from the installed production dependencies, and
CI (`pnpm notices:check`) fails when it is out of date, when a dependency has no licence text, or
when its licence is not on the GPL-compatible list in `scripts/third-party-notices.ts`. Licence texts
that npm packages do not carry are kept under [third_party/](third_party).

## Third-party

- **YuNet** face detection model, `face_detection_yunet_2026may.onnx`, from the
  [OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet),
  MIT licence, Copyright (c) 2020 Shiqi Yu. The licence text is in
  [third_party/yunet/LICENSE](third_party/yunet/LICENSE). The model is downloaded at install and
  not committed.
- **ONNX Runtime** (MIT, Microsoft), with the notices of the components in its native library in
  [third_party/onnxruntime/](third_party/onnxruntime).
- **Inter** and **JetBrains Mono**, SIL OFL 1.1, from `@fontsource-variable`; licences in
  [third_party/fonts/](third_party/fonts).
- This software is based in part on the work of the Independent JPEG Group: the progressive JPEG
  decoding follows libjpeg's algorithms ([third_party/libjpeg/](third_party/libjpeg)).
- Runtime libraries: Electron (MIT; Chromium's licences ship with it), React (MIT). Dev only:
  Playwright, Vitest, sharp and exiftool-vendored (used by tests as independent references), and the
  lint/build tooling.
