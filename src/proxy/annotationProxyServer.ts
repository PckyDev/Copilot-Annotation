import * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { load } from 'cheerio';
import {
  decodeOrigin,
  encodeOrigin,
  escapeAttribute,
  escapeInlineScript,
  getContentType,
  getTargetBase,
  hasRequestBody,
  isNotFoundError,
  loadInjectedBundle,
  normalizeHtmlDocument,
  readRequestBody,
  resolveFontAwesomeCssPath,
  resolveFontAwesomeRoot,
  resolveFontAwesomeWebfontsRoot,
  resolveInternalAssetPath,
  resolveLocalFileTarget,
  rewriteFontAwesomeCss,
  rewriteHtmlUrls,
  rewriteSetCookie
} from './helpers';

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
    this.injectedScript = loadInjectedBundle(path.join(extensionRoot, 'media', 'injected', 'runtime'), '.js');
    this.injectedStyle = loadInjectedBundle(path.join(extensionRoot, 'media', 'injected', 'styles'), '.css');
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
        shellToolbar: true,
        targetScheme: targetUrl.protocol,
        targetOrigin: targetUrl.origin,
        targetUrl: targetUrl.toString()
      })};`
    );

    $('head').prepend(`<style>${rewriteFontAwesomeCss(this.fontAwesomeCss, proxyOrigin, FONT_AWESOME_WEBFONT_PREFIX)}</style>`);
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
