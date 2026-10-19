import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import CollectorPanel from './collector/CollectorPanel';
import { ToastProvider } from './components/Toast';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      {/* The Collector window loads this same page with #collector. */}
      {window.location.hash === '#collector' ? <CollectorPanel /> : <App />}
    </ToastProvider>
  </StrictMode>,
);
