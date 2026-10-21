import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);
