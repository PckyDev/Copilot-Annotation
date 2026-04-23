import * as http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { load, type CheerioAPI } from 'cheerio';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade'
]);

const BLOCKED_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'origin-agent-cluster',
  'x-frame-options'
]);

const BLOCKED_REQUEST_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host'
]);

const FONT_AWESOME_WEBFONT_PREFIX = '/__copilot_annotation__/fontawesome-webfonts/';

export class AnnotationProxyServer implements vscode.Disposable {
  private readonly fontAwesomeCss: string;
  private readonly fontAwesomeWebfontsRoot: string;
  private readonly injectedScript: string;
  private readonly injectedStyle: string;
  private server: http.Server | undefined;
  private startPromise: Promise<void> | undefined;
  private port: number | undefined;

  public constructor(extensionRoot: string) {
    const fontAwesomeRoot = resolveFontAwesomeRoot(extensionRoot);

    this.fontAwesomeCss = readFileSync(resolveFontAwesomeCssPath(fontAwesomeRoot), 'utf8');
    this.fontAwesomeWebfontsRoot = resolveFontAwesomeWebfontsRoot(fontAwesomeRoot);
    this.injectedScript = readFileSync(path.join(extensionRoot, 'media', 'injected.js'), 'utf8');
    this.injectedStyle = readFileSync(path.join(extensionRoot, 'media', 'injected.css'), 'utf8');
  }

  public async ensureStarted(): Promise<void> {
    if (this.server && this.port) {
      return;
    }

    if (!this.startPromise) {
      this.startPromise = new Promise((resolve, reject) => {
        const server = http.createServer((request, response) => {
          void this.handleRequest(request, response);
        });

        server.once('error', (error) => {
          reject(error);
        });

        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Failed to determine proxy server address.'));
            return;
          }

          this.server = server;
          this.port = address.port;
          resolve();
        });
      });
    }

    await this.startPromise;
  }

  public async getPreviewUrl(rawTargetUrl: string): Promise<string> {
    await this.ensureStarted();
    const targetUrl = new URL(rawTargetUrl);
    return `${this.getProxyOrigin(targetUrl)}${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
  }

  public async getPreviewHtml(rawTargetUrl: string): Promise<string> {
    const previewUrl = await this.getPreviewUrl(rawTargetUrl);
    const response = await fetch(previewUrl);

    if (!response.ok) {
      throw new Error(`Failed to load preview HTML: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  }

  public dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.port = undefined;
    this.startPromise = undefined;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      this.applyCorsHeaders(response);

      const requestUrl = new URL(request.url ?? '/', 'http://copilot-annotation.local');

      if (await this.handleInternalAssetRequest(requestUrl, response, request.method)) {
        return;
      }

      if ((request.method ?? 'GET').toUpperCase() === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }

      const targetUrl = this.resolveTargetUrl(request);
      if (!targetUrl) {
        this.writePlainText(response, 400, 'Missing or invalid proxy host.');
        return;
      }

      if (targetUrl.protocol === 'file:') {
        await this.handleLocalFileRequest(request, response, targetUrl);
        return;
      }

      const upstreamHeaders = this.createUpstreamHeaders(request, targetUrl);
      const requestBody = hasRequestBody(request.method)
        ? new Uint8Array(await readRequestBody(request))
        : undefined;

      const upstreamResponse = await fetch(targetUrl, {
        method: request.method ?? 'GET',
        headers: upstreamHeaders,
        body: requestBody,
        redirect: 'manual'
      });

      const locationHeader = upstreamResponse.headers.get('location');
      if (locationHeader && upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
        const redirectTarget = new URL(locationHeader, targetUrl);
        this.writeRedirect(response, upstreamResponse, redirectTarget);
        return;
      }

      this.copyResponseHeaders(response, upstreamResponse.headers, targetUrl);
      response.statusCode = upstreamResponse.status;

      const contentType = upstreamResponse.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        const html = await upstreamResponse.text();
        const injectedHtml = this.injectHtml(html, targetUrl);
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(injectedHtml);
        return;
      }

      const body = Buffer.from(await upstreamResponse.arrayBuffer());
      response.end(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown proxy error.';
      this.writePlainText(response, 502, `Proxy request failed: ${message}`);
    }
  }

  private async handleInternalAssetRequest(
    requestUrl: URL,
    response: http.ServerResponse,
    requestMethod: string | undefined
  ): Promise<boolean> {
    if (!requestUrl.pathname.startsWith(FONT_AWESOME_WEBFONT_PREFIX)) {
      return false;
    }

    const method = (requestMethod ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) {
      response.statusCode = 405;
      response.setHeader('allow', 'GET, HEAD');
      response.end();
      return true;
    }

    const filePath = resolveInternalAssetPath(
      this.fontAwesomeWebfontsRoot,
      requestUrl.pathname.slice(FONT_AWESOME_WEBFONT_PREFIX.length)
    );
    const contentType = getContentType(filePath);

    response.statusCode = 200;
    response.setHeader('content-type', contentType);

    if (method === 'HEAD') {
      response.end();
      return true;
    }

    response.end(await readFile(filePath));
    return true;
  }

  private resolveTargetUrl(request: http.IncomingMessage): URL | undefined {
    const hostHeader = request.headers.host;
    if (!hostHeader) {
      return undefined;
    }

    const hostname = hostHeader.split(':')[0]?.toLowerCase();
    if (!hostname || !hostname.endsWith('.localhost')) {
      return undefined;
    }

    const encodedOrigin = hostname.slice(0, -'.localhost'.length);
    if (!encodedOrigin) {
      return undefined;
    }

    const targetBase = decodeOrigin(encodedOrigin);
    if (!targetBase) {
      return undefined;
    }

    return new URL(request.url ?? '/', targetBase);
  }

  private getProxyOrigin(targetUrl: URL): string {
    if (!this.port) {
      throw new Error('Proxy server is not running.');
    }

    return `http://${encodeOrigin(getTargetBase(targetUrl))}.localhost:${this.port}`;
  }

  private async handleLocalFileRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    requestedUrl: URL
  ): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) {
      response.statusCode = 405;
      response.setHeader('allow', 'GET, HEAD');
      response.end();
      return;
    }

    try {
      const { filePath, fileUrl } = await resolveLocalFileTarget(requestedUrl);
      const body = await readFile(filePath);
      const contentType = getContentType(filePath);

      response.statusCode = 200;
      response.setHeader('content-type', contentType);

      if (method === 'HEAD') {
        response.end();
        return;
      }

      if (contentType.startsWith('text/html')) {
        const injectedHtml = this.injectHtml(body.toString('utf8'), fileUrl);
        response.end(injectedHtml);
        return;
      }

      response.end(body);
    } catch (error) {
      const statusCode = isNotFoundError(error) ? 404 : 500;
      const message = error instanceof Error ? error.message : 'Unknown local file error.';
      this.writePlainText(response, statusCode, `Local file request failed: ${message}`);
    }
  }

  private createUpstreamHeaders(request: http.IncomingMessage, targetUrl: URL): Headers {
    const headers = new Headers();

    for (const [rawName, rawValue] of Object.entries(request.headers)) {
      if (!rawValue) {
        continue;
      }

      const name = rawName.toLowerCase();
      if (BLOCKED_REQUEST_HEADERS.has(name) || HOP_BY_HOP_HEADERS.has(name)) {
        continue;
      }

      if (name === 'origin') {
        headers.set('origin', targetUrl.origin);
        continue;
      }

      if (name === 'referer') {
        headers.set('referer', targetUrl.toString());
        continue;
      }

      headers.set(name, Array.isArray(rawValue) ? rawValue.join(', ') : rawValue);
    }

    return headers;
  }

  private writeRedirect(
    response: http.ServerResponse,
    upstreamResponse: Response,
    redirectTarget: URL
  ): void {
    this.copyResponseHeaders(response, upstreamResponse.headers, redirectTarget);
    response.statusCode = upstreamResponse.status;
    response.setHeader('location', `${this.getProxyOrigin(redirectTarget)}${redirectTarget.pathname}${redirectTarget.search}${redirectTarget.hash}`);
    response.end();
  }

  private copyResponseHeaders(response: http.ServerResponse, headers: Headers, targetUrl: URL): void {
    const rewrittenCookies: string[] = [];
    const rawSetCookie = 'getSetCookie' in headers
      ? (headers as Headers & { getSetCookie(): string[] }).getSetCookie()
      : [];

    headers.forEach((rawValue, rawName) => {
      const name = rawName.toLowerCase();
      if (name === 'set-cookie') {
        return;
      }

      if (BLOCKED_RESPONSE_HEADERS.has(name) || HOP_BY_HOP_HEADERS.has(name)) {
        return;
      }

      response.setHeader(name, rawValue);
    });

    for (const cookie of rawSetCookie) {
      rewrittenCookies.push(rewriteSetCookie(cookie, targetUrl));
    }

    if (rewrittenCookies.length > 0) {
      response.setHeader('set-cookie', rewrittenCookies);
    }
  }

  private injectHtml(html: string, targetUrl: URL): string {
    const proxyOrigin = this.getProxyOrigin(targetUrl);
    const $ = load(normalizeHtmlDocument(html), {
      scriptingEnabled: true
    });

    $('meta[http-equiv]').each((_index, element) => {
      const httpEquiv = $(element).attr('http-equiv')?.toLowerCase();
      if (httpEquiv === 'content-security-policy' || httpEquiv === 'x-frame-options') {
        $(element).remove();
      }
    });

    $('base').remove();
    rewriteHtmlUrls($, targetUrl, proxyOrigin);

    const runtimeConfig = escapeInlineScript(
      `window.__COPILOT_ANNOTATION__ = ${JSON.stringify({
        proxyOrigin,
        targetScheme: targetUrl.protocol,
        targetOrigin: targetUrl.origin,
        targetUrl: targetUrl.toString()
      })};`
    );

    $('head').prepend(`<style>${rewriteFontAwesomeCss(this.fontAwesomeCss, proxyOrigin)}</style>`);
    $('head').prepend(`<script>${escapeInlineScript(this.injectedScript)}</script>`);
    $('head').prepend(`<script>${runtimeConfig}</script>`);
    $('head').prepend(`<style>${this.injectedStyle}</style>`);
    $('head').prepend(`<base href="${escapeAttribute(targetUrl.toString())}">`);
    $('head').prepend('<meta name="viewport" content="width=device-width, initial-scale=1.0">');

    return $.html();
  }

  private writePlainText(response: http.ServerResponse, statusCode: number, message: string): void {
    response.statusCode = statusCode;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end(message);
  }

  private applyCorsHeaders(response: http.ServerResponse): void {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    response.setHeader('access-control-allow-headers', '*');
  }
}

function hasRequestBody(method: string | undefined): boolean {
  return method !== undefined && !['GET', 'HEAD'].includes(method.toUpperCase());
}

async function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function encodeOrigin(origin: string): string {
  const hex = Buffer.from(origin, 'utf8').toString('hex');
  return hex.match(/.{1,60}/g)?.join('.') ?? hex;
}

function decodeOrigin(encodedOrigin: string): string | undefined {
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

function getTargetBase(targetUrl: URL): string {
  if (targetUrl.protocol === 'file:') {
    return 'file://';
  }

  return targetUrl.origin;
}

function normalizeHtmlDocument(html: string): string {
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

function resolveFontAwesomeRoot(extensionRoot: string): string {
  const packagedRoot = path.join(extensionRoot, 'media', 'vendor', 'fontawesome');
  if (pathExists(path.join(packagedRoot, 'all.min.css')) && pathExists(path.join(packagedRoot, 'webfonts'))) {
    return packagedRoot;
  }

  return path.join(extensionRoot, 'node_modules', '@fortawesome', 'fontawesome-free');
}

function resolveFontAwesomeCssPath(fontAwesomeRoot: string): string {
  const packagedCssPath = path.join(fontAwesomeRoot, 'all.min.css');
  if (pathExists(packagedCssPath)) {
    return packagedCssPath;
  }

  return path.join(fontAwesomeRoot, 'css', 'all.min.css');
}

function resolveFontAwesomeWebfontsRoot(fontAwesomeRoot: string): string {
  return path.join(fontAwesomeRoot, 'webfonts');
}

function pathExists(candidatePath: string): boolean {
  return existsSync(candidatePath);
}

function rewriteFontAwesomeCss(css: string, proxyOrigin: string): string {
  return css.replace(/\.\.\/webfonts\//g, `${proxyOrigin}${FONT_AWESOME_WEBFONT_PREFIX}`);
}

function rewriteHtmlUrls($: CheerioAPI, targetUrl: URL, proxyOrigin: string): void {
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

function shouldSkipUrlRewrite(value: string): boolean {
  return value.startsWith('#')
    || value.startsWith('data:')
    || value.startsWith('blob:')
    || value.startsWith('mailto:')
    || value.startsWith('tel:')
    || value.startsWith('javascript:');
}

function rewriteSetCookie(cookie: string, targetUrl: URL): string {
  return cookie
    .replace(/;\s*Domain=[^;]+/gi, '')
    .replace(/;\s*Secure/gi, targetUrl.protocol === 'https:' ? '; Secure' : '')
    .replace(/SameSite=None/gi, targetUrl.protocol === 'https:' ? 'SameSite=None' : 'SameSite=Lax');
}

function escapeInlineScript(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveInternalAssetPath(rootPath: string, relativeAssetPath: string): string {
  const normalizedRelativePath = path.normalize(relativeAssetPath).replace(/^[\\/]+/, '');
  const resolvedPath = path.resolve(rootPath, normalizedRelativePath);
  const relativeToRoot = path.relative(rootPath, resolvedPath);

  if (!normalizedRelativePath || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error('Invalid internal asset path.');
  }

  return resolvedPath;
}

async function resolveLocalFileTarget(targetUrl: URL): Promise<{ filePath: string; fileUrl: URL }> {
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

function getContentType(filePath: string): string {
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

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT');
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