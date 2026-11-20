# MediaPipe selfie multiclass segmenter

`selfie-multiclass.onnx` labels each pixel as background, hair, body skin, face skin, clothes or
other, for the Outlines face shape. It is the MediaPipe selfie multiclass segmentation model
(256×256) by Google, licensed under the Apache License 2.0 in [LICENSE](./LICENSE).

Changes: converted from TFLite to ONNX with tf2onnx (opset 13), and internal names renamed so the
conversion is reproducible. Weights unchanged.

The model is not committed. `pnpm install` (or `pnpm fetch-model`) downloads it from
[pixlad-models](https://github.com/filipkauffeldt/pixlad-models) into `resources/models/` and
checks the SHA-256.

- Source: `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite`
- SHA-256: `e794d96267759b9f15ac59382abfbde6f4fe89ae10831da2c73509de38212b14`
- Input: `1 x 256 x 256 x 3` float32, RGB, 0..1
