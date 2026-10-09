// Yield a rendering opportunity for SSR HTML before loading the hydration runtime.
// Background documents do not receive animation frames, so start there immediately.
let started = false;
const hydrate = () => {
  if (started) return;
  started = true;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  void import('./hydrate.tsx');
};
const onVisibilityChange = () => {
  if (document.visibilityState === 'hidden') hydrate();
};
document.addEventListener('visibilitychange', onVisibilityChange);
if (document.visibilityState === 'hidden') hydrate();
else requestAnimationFrame(hydrate);
