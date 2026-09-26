import { useEffect, useState } from 'react';

// light | dark | system, saved per browser. index.html applies it before first paint.
const KEY = 'peak_theme';
const read = () => {
  try {
    return localStorage.getItem(KEY) || 'system';
  } catch {
    return 'system';
  }
};
const resolve = (t) => (t === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t);

export function useTheme() {
  const [theme, setTheme] = useState(read);

  useEffect(() => {
    const apply = () => {
      const r = resolve(theme);
      document.documentElement.setAttribute('data-theme', r);
      document.documentElement.style.colorScheme = r;
    };
    apply();
    try {
      localStorage.setItem(KEY, theme);
    } catch {}
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  return [theme, setTheme];
}
