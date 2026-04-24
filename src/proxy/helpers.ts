import * as http from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CheerioAPI } from 'cheerio';

export function hasRequestBody(method: string | undefined): boolean {
  return method !== undefined && !['GET', 'HEAD'].includes(method.toUpperCase());
}

export async function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export function encodeOrigin(origin: string): string {
  const hex = Buffer.from(origin, 'utf8').toString('hex');
  return hex.match(/.{1,60}/g)?.join('.') ?? hex;
}

export function decodeOrigin(encodedOrigin: string): string | undefined {
  const hex = encodedOrigin.split('.').join('');
  if (!/^[0-9a-f]+$/i.test(hex)) {
    return undefined;
  }

  try {
    return Buffer.from(hex, 'hex').toString('utf8');
  } catch {
    return undefined;
  }
}

export function getTargetBase(targetUrl: URL): string {
  if (targetUrl.protocol === 'file:') {
    return 'file://';
  }

  return targetUrl.origin;
}

export function normalizeHtmlDocument(html: string): string {
  if (/<!doctype/i.test(html) || /<html[\s>]/i.test(html)) {
    return html;
  }

  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<style>html, body { margin: 0; padding: 0; width: 100%; }</style>',
    '</head>',
    `<body>${html}</body>`,
    '</html>'
  ].join('');
}

export function loadInjectedBundle(directoryPath: string, extension: '.js' | '.css'): string {
  const entryPaths = getInjectedBundleEntryPaths(directoryPath, extension);

  if (entryPaths.length === 0) {
    throw new Error(`No injected ${extension} fragments found in ${directoryPath}.`);
  }

  return entryPaths
    .map((entryPath) => readFileSync(entryPath, 'utf8'))
    .join('\n\n');
}

function getInjectedBundleEntryPaths(directoryPath: string, extension: '.js' | '.css'): string[] {
  const manifestPath = path.join(directoryPath, 'bundle.manifest.json');
  if (!pathExists(manifestPath)) {
    return readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === extension)
      .map((entry) => path.join(directoryPath, entry.name))
      .sort((left, right) => left.localeCompare(right));
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read injected bundle manifest at ${manifestPath}: ${String(error)}`);
  }

  const entryNames = (manifest as { entries?: unknown }).entries;
  if (!Array.isArray(entryNames) || entryNames.length === 0) {
    throw new Error(`Injected bundle manifest at ${manifestPath} must contain a non-empty entries array.`);
  }

  const seen = new Set<string>();
  return entryNames.map((entryName) => {
    if (typeof entryName !== 'string' || entryName.trim().length === 0) {
      throw new Error(`Injected bundle manifest at ${manifestPath} contains an invalid entry name.`);
    }

    if (path.extname(entryName).toLowerCase() !== extension) {
      throw new Error(`Injected bundle manifest at ${manifestPath} contains ${entryName}, which does not match ${extension}.`);
    }

    if (seen.has(entryName)) {
      throw new Error(`Injected bundle manifest at ${manifestPath} contains a duplicate entry for ${entryName}.`);
    }
    seen.add(entryName);

    const resolvedPath = resolveInternalAssetPath(directoryPath, entryName);
    if (!pathExists(resolvedPath)) {
      throw new Error(`Injected bundle manifest at ${manifestPath} references missing file ${entryName}.`);
    }

    return resolvedPath;
  });
}

export function resolveFontAwesomeRoot(extensionRoot: string): string {
  const packagedRoot = path.join(extensionRoot, 'media', 'vendor', 'fontawesome');
  if (pathExists(path.join(packagedRoot, 'all.min.css')) && pathExists(path.join(packagedRoot, 'webfonts'))) {
    return packagedRoot;
  }

  return path.join(extensionRoot, 'node_modules', '@fortawesome', 'fontawesome-free');
}

export function resolveFontAwesomeCssPath(fontAwesomeRoot: string): string {
  const packagedCssPath = path.join(fontAwesomeRoot, 'all.min.css');
  if (pathExists(packagedCssPath)) {
    return packagedCssPath;
  }

  return path.join(fontAwesomeRoot, 'css', 'all.min.css');
}

export function resolveFontAwesomeWebfontsRoot(fontAwesomeRoot: string): string {
  return path.join(fontAwesomeRoot, 'webfonts');
}

export function rewriteFontAwesomeCss(css: string, proxyOrigin: string, webfontPrefix: string): string {
  return css.replace(/\.\.\/webfonts\//g, `${proxyOrigin}${webfontPrefix}`);
}

export function rewriteHtmlUrls($: CheerioAPI, targetUrl: URL, proxyOrigin: string): void {
  const attributeNames = ['href', 'src', 'action', 'poster'];

  for (const attributeName of attributeNames) {
    $(`[${attributeName}]`).each((_index, element) => {
      const currentValue = $(element).attr(attributeName);
      if (!currentValue || shouldSkipUrlRewrite(currentValue)) {
        return;
      }

      const resolved = new URL(currentValue, targetUrl);
      if (resolved.origin === targetUrl.origin) {
        $(element).attr(attributeName, `${proxyOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`);
      }
    });
  }

  $('[srcset]').each((_index, element) => {
    const currentValue = $(element).attr('srcset');
    if (!currentValue) {
      return;
    }

    const rewritten = currentValue
      .split(',')
      .map((segment) => {
        const [candidateUrl, descriptor] = segment.trim().split(/\s+/, 2);
        if (!candidateUrl || shouldSkipUrlRewrite(candidateUrl)) {
          return segment.trim();
        }

        const resolved = new URL(candidateUrl, targetUrl);
        const proxied = resolved.origin === targetUrl.origin
          ? `${proxyOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`
          : resolved.toString();

        return descriptor ? `${proxied} ${descriptor}` : proxied;
      })
      .join(', ');

    $(element).attr('srcset', rewritten);
  });
}

export function rewriteSetCookie(cookie: string, targetUrl: URL): string {
  return cookie
    .replace(/;\s*Domain=[^;]+/gi, '')
    .replace(/;\s*Secure/gi, targetUrl.protocol === 'https:' ? '; Secure' : '')
    .replace(/SameSite=None/gi, targetUrl.protocol === 'https:' ? 'SameSite=None' : 'SameSite=Lax');
}

export function escapeInlineScript(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function resolveInternalAssetPath(rootPath: string, relativeAssetPath: string): string {
  const normalizedRelativePath = path.normalize(relativeAssetPath).replace(/^[\\/]+/, '');
  const resolvedPath = path.resolve(rootPath, normalizedRelativePath);
  const relativeToRoot = path.relative(rootPath, resolvedPath);

  if (!normalizedRelativePath || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error('Invalid internal asset path.');
  }

  return resolvedPath;
}

export async function resolveLocalFileTarget(targetUrl: URL): Promise<{ filePath: string; fileUrl: URL }> {
  const requestedPath = fileURLToPath(targetUrl);
  const requestedStats = await stat(requestedPath);

  if (requestedStats.isDirectory()) {
    const normalizedDirectoryUrl = targetUrl.pathname.endsWith('/')
      ? targetUrl
      : new URL(`${targetUrl.toString()}/`);
    const indexUrl = new URL('index.html', normalizedDirectoryUrl);
    return {
      filePath: fileURLToPath(indexUrl),
      fileUrl: indexUrl
    };
  }

  return {
    filePath: requestedPath,
    fileUrl: targetUrl
  };
}

export function getContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream';

  if (
    contentType.startsWith('text/')
    || contentType === 'application/javascript'
    || contentType === 'application/json'
    || contentType === 'application/xml'
    || contentType === 'image/svg+xml'
  ) {
    return `${contentType}; charset=utf-8`;
  }

  return contentType;
}

export function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

function pathExists(candidatePath: string): boolean {
  return existsSync(candidatePath);
}

function shouldSkipUrlRewrite(value: string): boolean {
  return value.startsWith('#')
    || value.startsWith('data:')
    || value.startsWith('blob:')
    || value.startsWith('mailto:')
    || value.startsWith('tel:')
    || value.startsWith('javascript:');
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.mjs': 'application/javascript',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml'
};