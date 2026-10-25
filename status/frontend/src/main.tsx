import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { trackPageViews } from './analytics';
import './styles.css';

trackPageViews();

// The viewport meta turns zoom off, but iOS Safari ignores user-scalable=no, so pinches are cancelled here too.
// Screenshots open full size in their own tab, where zooming still works.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
