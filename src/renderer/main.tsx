// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './global.css';
import './app.css';
import { isMac } from './flips';
import { EDIT_BAR_HEIGHT, TOP_BAR_HEIGHT } from '../shared/layout';
import { getState, subscribe, unexportedCount } from './store';

// The top bar makes room for the window buttons, and they sit on the other side on a Mac.
document.documentElement.dataset['platform'] = isMac ? 'mac' : 'other';
document.documentElement.style.setProperty('--topbar-h', `${TOP_BAR_HEIGHT}px`);
document.documentElement.style.setProperty('--edit-bar-h', `${EDIT_BAR_HEIGHT}px`);

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
