// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt

/** Where the face models are. YuNet finds faces; the others find heads and outline faces. */
export interface ModelPaths {
  yunet: string;
  deimS: string;
  deimN: string;
  segmenter: string;
}
