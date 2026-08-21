import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from './components/error-boundary';
import { initAuth } from './lib/entra';

import './index.css';

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
