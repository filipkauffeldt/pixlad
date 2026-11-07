// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './global.css';
import './app.css';
import { getState, subscribe, unexportedCount } from './store';

// The main process asks before closing with mosaics that were not exported; it needs the count.
let last = -1;
subscribe(() => {
  const count = unexportedCount(getState());
  if (count !== last) {
    last = count;
    window.api.setUnexported(count);
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
