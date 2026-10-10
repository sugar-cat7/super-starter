import './styles.css';
import { StrictMode, startTransition, createElement } from 'react';
import { hydrateRoot } from 'react-dom/client';

// Initialize React normally; load the route framework independently of the entry.
void import('@tanstack/react-start/client').then(({ StartClient }) => {
  startTransition(() => {
    hydrateRoot(document, createElement(StrictMode, null, createElement(StartClient)));
  });
});
