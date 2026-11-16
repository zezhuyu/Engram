import { browserModels } from './models.js';
import { coreJs } from './web/core.js';
import { serverPagesJs } from './web/server-pages.js';
import { serverAppJs } from './web/server-app.js';
import { clientPagesJs } from './web/client-pages.js';
import { clientAppJs } from './web/client-app.js';
import { designCss } from './web/design.js';
import { featureCss } from './web/features.js';
import { pageHtml, type DashboardMode } from './web/page.js';
import { fontAssets, fontFaceCss } from './fonts.js';

type Asset = { contentType: string; body: string | Buffer };

/**
 * The served script of each mode is built from its own parts only: the shared core plus that mode's pages and app.
 * The server script contains no client page, handler or label, and the client script contains no server administration.
 */
export function scriptFor(mode: DashboardMode): string {
  return mode === 'server' ? [browserModels, coreJs, serverPagesJs, serverAppJs].join('\n') : [coreJs, clientPagesJs, clientAppJs].join('\n');
}

export const styleSheet = fontFaceCss + designCss + featureCss;

export function assetsFor(mode: DashboardMode): Record<string, Asset> {
  return {
    '/': { contentType: 'text/html; charset=utf-8', body: pageHtml(mode) },
    '/assets/app.css': { contentType: 'text/css; charset=utf-8', body: styleSheet },
    '/assets/app.js': { contentType: 'text/javascript; charset=utf-8', body: scriptFor(mode) },
    ...fontAssets
  };
}

/** Compatibility export: the server dashboard's assets (tests and older imports use `assets`). */
export const assets: Record<string, { contentType: string; body: string }> = assetsFor('server') as Record<string, { contentType: string; body: string }>;
