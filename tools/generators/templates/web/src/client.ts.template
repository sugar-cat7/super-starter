import './styles.css';
import { StrictMode, startTransition, createElement } from 'react';

// Let the styled SSR document render, then initialize each runtime across frames.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    void import('react-dom/client').then(({ hydrateRoot }) => {
      requestAnimationFrame(() => {
        void import('@tanstack/react-start/client').then(({ StartClient }) => {
          startTransition(() => {
            hydrateRoot(document, createElement(StrictMode, null, createElement(StartClient)));
          });
        });
      });
    });
  });
});
