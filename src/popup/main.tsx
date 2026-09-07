/**
 * Popup entry point.
 *
 * Kept deliberately thin: a browser-action popup is torn down on every close,
 * so the only job here is to mount `App` as fast as possible and to fail
 * loudly (in the popup's own console) if the host document is missing #root.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { log } from '@/shared/logger';

import { AuthGate } from './components/AuthGate';
import './styles.css';
import './auth.css';

const container = document.getElementById('root');

if (container) {
  createRoot(container).render(
    <StrictMode>
      <AuthGate />
    </StrictMode>,
  );
} else {
  log.error('popup: #root is missing from popup.html');
}
