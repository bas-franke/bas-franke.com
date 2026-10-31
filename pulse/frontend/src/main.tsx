import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { trackPageViews } from './analytics';
import App from './App';
import './theme';
import './styles.css';
import './pages/pages.css';

trackPageViews();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
