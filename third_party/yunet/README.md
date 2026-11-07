# YuNet face detector

`face_detection_yunet_2026may.onnx` is the dynamic-input YuNet model from the
[OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet),
licensed under the MIT licence in [LICENSE](./LICENSE) (Copyright (c) 2020 Shiqi Yu).

The model is not committed. `pnpm install` (or `pnpm fetch-model`) downloads it into
`resources/models/` and checks the SHA-256.

- Source: `https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2026may.onnx`
- SHA-256: `ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0`
- Input: `1 x 3 x H x W` float32, BGR, 0..255, H and W multiples of 32
