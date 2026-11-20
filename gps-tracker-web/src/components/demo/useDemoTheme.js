import { useLayoutEffect } from 'react';
import { themeProperties } from '../../lib/themeTokens.js';

const lightTokens = Object.entries(themeProperties('light')).map(([name,value]) => name + ':' + value).join(';');

export function useDemoTheme() {
  useLayoutEffect(() => {
    // Body also contains modal portals. Inheriting here leaves the root's account theme intact.
    const style = document.createElement('style');
    style.textContent = 'body {color-scheme:light;' + lightTokens + '}';
    document.head.appendChild(style);
    return () => style.remove();
  }, []);
}
