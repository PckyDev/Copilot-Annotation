import * as nodePath from 'node:path';
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';

export function getInitialTarget(context: vscode.ExtensionContext): string {
  const activeHtmlFile = getActiveHtmlFilePath();
  if (activeHtmlFile) {
    return activeHtmlFile;
  }

  const configuration = vscode.workspace.getConfiguration('copilotAnnotation');
  const configuredUrl = configuration.get<string>('defaultUrl')?.trim();
  const lastUrl = context.globalState.get<string>('copilotAnnotation.lastUrl')?.trim();

  return lastUrl || configuredUrl || 'http://127.0.0.1:3000';
}

export function resolveTargetInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Target is required.');
  }

  if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
    const resolvedUrl = new URL(trimmed);
    if (!['http:', 'https:', 'file:'].includes(resolvedUrl.protocol)) {
      throw new Error('Unsupported protocol.');
    }

    return resolvedUrl.toString();
  }

  if (looksLikeLocalPath(trimmed)) {
    try {
      return vscode.Uri.file(resolveLocalPath(trimmed)).toString();
    } catch (error) {
      if (!looksLikeNetworkTarget(trimmed)) {
        throw error;
      }
    }
  }

  return new URL(`http://${trimmed}`).toString();
}

export function toExternalUri(targetUrl: string): vscode.Uri {
  return vscode.Uri.parse(targetUrl);
}

export function getTargetDisplayName(targetUrl: URL): string {
  if (targetUrl.protocol === 'file:') {
    const fileName = nodePath.basename(decodeURIComponent(targetUrl.pathname));
    return fileName || 'Local File';
  }

  return targetUrl.host;
}

function getActiveHtmlFilePath(): string | undefined {
  const document = vscode.window.activeTextEditor?.document;
  if (!document || document.uri.scheme !== 'file') {
    return undefined;
  }

  const extension = nodePath.extname(document.uri.fsPath).toLowerCase();
  if (!['.html', '.htm'].includes(extension)) {
    return undefined;
  }

  return document.uri.fsPath;
}

function looksLikeLocalPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value)
    || value.startsWith('\\\\')
    || value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('.\\')
    || value.startsWith('..\\')
    || value.includes('\\')
    || value.includes('/')
    || /\.(html?|xhtml)$/i.test(value);
}

function looksLikeNetworkTarget(value: string): boolean {
  return /^(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i.test(value)
    || (/^[^\s/\\]+\.[^\s/\\]+(?::\d+)?$/i.test(value) && !/\.(html?|xhtml)$/i.test(value))
    || /^(?:[^\s/\\]+\.)+[^\s/\\]+(?::\d+)?[/?#].+$/i.test(value);
}

function resolveLocalPath(inputPath: string): string {
  const normalizedInput = nodePath.normalize(inputPath);
  const candidatePaths = new Set<string>();

  if (nodePath.isAbsolute(normalizedInput)) {
    candidatePaths.add(normalizedInput);
  } else {
    const activeFilePath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : undefined;
    const activeDirectory = activeFilePath ? nodePath.dirname(activeFilePath) : undefined;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (activeDirectory) {
      candidatePaths.add(nodePath.resolve(activeDirectory, normalizedInput));
    }

    if (workspaceFolder) {
      candidatePaths.add(nodePath.resolve(workspaceFolder, normalizedInput));
    }

    candidatePaths.add(nodePath.resolve(normalizedInput));
  }

  for (const candidatePath of candidatePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  throw new Error('Local file does not exist.');
}