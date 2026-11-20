// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { countAreas } from './retouch';
import type { PhotoState } from './store';

/** One count as "on/total": the switched-on part bright, the total dim. */
function Count({
  label,
  on,
  total,
  testId,
}: {
  label: string;
  on: number;
  total: number;
  testId: string;
}) {
  return (
    <span className="readout">
      <span className="label">{label}</span>
      <span className="value mono" data-testid={testId}>
        {on}
        <span className="total">/{total}</span>
      </span>
    </span>
  );
}

/** How many of the photo's faces and drawn areas are switched on, under the photo. */
export function AreaCounts({ photo }: { photo: PhotoState }) {
  const counts = countAreas(photo.areas);
  return (
    <span className="counts" data-testid="area-counts">
      {counts.faces.total > 0 ? (
        <Count label="Faces" {...counts.faces} testId="face-count" />
      ) : (
        <span className="readout">
          <span className="label">Faces</span>
          <span className="value mono total">0</span>
        </span>
      )}
      {counts.drawn.total > 0 && <Count label="Areas" {...counts.drawn} testId="drawn-count" />}
    </span>
  );
}
