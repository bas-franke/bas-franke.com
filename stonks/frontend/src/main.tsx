import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { trackPageViews } from './analytics';
import './theme';
import './styles.css';

trackPageViews();

const render = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

// Dev-only fake backend (VITE_MOCK=1 npm run dev). The condition is false at build time, so the mock is not bundled.
if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') import('./mock').then(render);
else render();
