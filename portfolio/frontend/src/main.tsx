import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { trackPageViews } from './analytics';
import './styles/index.css';

trackPageViews();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
