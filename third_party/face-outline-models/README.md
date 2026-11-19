# Face outline models

`deimv2-s-wholebody34.onnx`, `deimv2-n-wholebody34.onnx` and `selfie-multiclass.onnx` find heads and
trace face outlines (Outlines in the face shape menu). They are licensed under the Apache License 2.0
in [LICENSE](./LICENSE). Where they come from and what was changed is in
[NOTICE.md](https://github.com/filipkauffeldt/pixlad-models/blob/main/NOTICE.md) of
[pixlad-models](https://github.com/filipkauffeldt/pixlad-models), which also holds the script that
rebuilds them.

The models are not committed. `pnpm install` (or `pnpm fetch-model`) downloads them from the
release of that repository into `resources/models/` and checks the SHA-256.
