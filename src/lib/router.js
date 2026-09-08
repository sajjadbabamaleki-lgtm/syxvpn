import { useEffect, useState, useCallback } from 'react';

/**
 * Hash router. Small on purpose: this dashboard is used on phones over poor
 * links, and a routing library would cost more than it earns here.
 */
export function currentPath() {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || '/';
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (replace) window.location.replace(target);
  else window.location.hash = path;
}

export function useRoute() {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

/** Matches `/users/:id` style patterns and returns params, or null. */
export function match(pattern, path) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    else if (patternParts[i] !== pathParts[i]) return null;
  }
  return params;
}

export function useBack(fallback = '/') {
  return useCallback(() => {
    if (window.history.length > 1) window.history.back();
    else navigate(fallback, { replace: true });
  }, [fallback]);
}
