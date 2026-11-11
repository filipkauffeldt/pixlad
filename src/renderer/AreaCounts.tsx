// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { countAreas } from './retouch';
import type { PhotoState } from './store';

/** How many of the photo's faces and drawn areas are switched on, for the footer. */
export function AreaCounts({ photo }: { photo: PhotoState }) {
  const counts = countAreas(photo.areas);
  return (
    <span className="counts" data-testid="area-counts">
      {counts.faces.total > 0 && (
        <span data-testid="face-count">{`${counts.faces.on} of ${counts.faces.total} faces on`}</span>
      )}
      {counts.drawn.total > 0 && (
        <span data-testid="drawn-count">{`${counts.drawn.on} of ${counts.drawn.total} areas on`}</span>
      )}
    </span>
  );
}
