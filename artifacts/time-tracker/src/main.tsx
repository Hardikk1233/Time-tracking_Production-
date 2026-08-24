import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from './components/error-boundary';
import { initAuth } from './lib/entra';
import { installErrorReporting } from './lib/error-reporting';

import './index.css';

// Installed before anything else so a crash during sign-in configuration or the
// first render is captured rather than only reaching the browser's console.
installErrorReporting();

// Sign-in configuration is resolved before the first render so the bearer-token
// getter is registered ahead of any API call. `finally` rather than `then`: if
// the lookup fails the app still mounts, on password sign-in.
initAuth().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
});
