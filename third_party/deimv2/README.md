# DEIMv2 Wholebody34 head detectors

`deimv2-s-wholebody34.onnx` and `deimv2-n-wholebody34.onnx` find heads, faces, eyes and hands for
the Outlines face shape. They are DEIMv2-Wholebody34 S and N by Katsuya Hyodo (PINTO0309), built on
DEIMv2 by Intellindust AI Lab, from the
[PINTO model zoo](https://github.com/PINTO0309/PINTO_model_zoo/tree/main/472_DEIMv2-Wholebody34),
licensed under the Apache License 2.0 in [LICENSE](./LICENSE).

Unchanged apart from the file names
(`deimv2_dinov3_s_wholebody34_1750query_640x640_nopre.onnx` and
`deimv2_hgnetv2_n_wholebody34_680query_640x640_nopre.onnx`).

The models are not committed. `pnpm install` (or `pnpm fetch-model`) downloads them from
[pixlad-models](https://github.com/filipkauffeldt/pixlad-models) into `resources/models/` and
checks the SHA-256.

- `deimv2-s-wholebody34.onnx` SHA-256: `ec0b4ac5a171615076e76f70f44f95f1f1adfe3d823d0574c5ba813abfe02e17`
- `deimv2-n-wholebody34.onnx` SHA-256: `5854666f0048caa3b9995043247a554dfe6ad2d3017eddfeed8ec90a748fbf9b`
- Input: `1 x 3 x 640 x 640` float32, RGB, ImageNet mean and standard deviation
