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

Download a package from the [Releases page](https://github.com/filipkauffeldt/pixlad/releases)
for macOS (Apple Silicon), Windows (x64) or Fedora (x64). No builds are signed in a way that
Microsoft or Apple trusts, so macOS and Windows warn you on first launch. If you want to, you can
always [build the app from source](#develop).

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
