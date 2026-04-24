import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { sendToCopilot } from './copilot/chat';
import { AnnotationProxyServer } from './proxy/annotationProxyServer';
import { getPreviewShellHtml } from './preview/shellHtml';
import { getInitialTarget, getTargetDisplayName, resolveTargetInput, toExternalUri } from './preview/targeting';

type WebviewMessage =
  | { type: 'reloadTarget'; url: string }
  | { type: 'openExternal'; url: string }
  | { type: 'openMarkdown'; markdown: string; sourceUrl: string }
  | { type: 'copyMarkdown'; markdown: string }
  | { type: 'sendToCopilot'; markdown: string; sourceUrl: string }
  | { type: 'runtimeReady' }
  | { type: 'status'; text: string }
  | { type: 'toolbarState'; tool: string; annotationCount: number }
  | { type: 'navigated'; url: string };

let currentPanel: vscode.WebviewPanel | undefined;
let currentPreviewTargetUrl: string | undefined;
let currentLocalPreviewWatcher: vscode.FileSystemWatcher | undefined;
let scheduledPreviewReload: ReturnType<typeof setTimeout> | undefined;
let isReloadingPreview = false;
let queuedPreviewReload = false;
let currentServer: AnnotationProxyServer | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      if (shouldAutoReloadOnWorkspaceMutation() && currentServer) {
        schedulePreviewReload(currentServer);
      }
    }),
    vscode.workspace.onDidCreateFiles(() => {
      if (shouldAutoReloadOnWorkspaceMutation() && currentServer) {
        schedulePreviewReload(currentServer);
      }
    }),
    vscode.workspace.onDidDeleteFiles(() => {
      if (shouldAutoReloadOnWorkspaceMutation() && currentServer) {
        schedulePreviewReload(currentServer);
      }
    }),
    vscode.workspace.onDidRenameFiles(() => {
      if (shouldAutoReloadOnWorkspaceMutation() && currentServer) {
        schedulePreviewReload(currentServer);
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotAnnotation.openPreview', async () => {
      try {
        const initialTarget = getInitialTarget(context);
        const enteredUrl = await vscode.window.showInputBox({
          prompt: 'Enter a website URL or local HTML file path to annotate',
          placeHolder: 'http://127.0.0.1:3000 or C:\\site\\index.html',
          value: initialTarget,
          validateInput: (value) => {
            try {
              resolveTargetInput(value);
              return undefined;
            } catch {
              return 'Enter a valid http:// or https:// URL, file:// URI, or an existing local HTML file path.';
            }
          }
        });

        if (!enteredUrl) {
          return;
        }

        const targetUrl = resolveTargetInput(enteredUrl);
        const server = await getOrCreateServer(context);
        await context.globalState.update('copilotAnnotation.lastUrl', targetUrl);

        if (!currentPanel) {
          currentPanel = createPreviewPanel(context, server);
        }

        await loadPreviewIntoPanel(currentPanel, context, server, targetUrl);
        currentPanel.reveal(vscode.ViewColumn.Beside, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown preview error.';
        void vscode.window.showErrorMessage(`Copilot Annotation could not open the preview: ${message}`);
      }
    })
  );
}

export function deactivate(): void {
  extensionContext = undefined;
  resetPreviewTracking();
  currentServer = undefined;
  currentPanel?.dispose();
}

async function getOrCreateServer(context: vscode.ExtensionContext): Promise<AnnotationProxyServer> {
  if (!currentServer) {
    currentServer = new AnnotationProxyServer(context.extensionUri.fsPath);
    context.subscriptions.push(currentServer);
  }

  await currentServer.ensureStarted();
  return currentServer;
}

function createPreviewPanel(
  context: vscode.ExtensionContext,
  server: AnnotationProxyServer
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'copilotAnnotation.preview',
    'Copilot Annotation',
    {
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.Beside
    },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'media')
      ]
    }
  );

  panel.onDidDispose(() => {
    if (currentPanel === panel) {
      currentPanel = undefined;
      resetPreviewTracking();
    }
  });

  panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
    switch (message.type) {
      case 'reloadTarget': {
        const normalizedUrl = resolveTargetInput(message.url);
        await context.globalState.update('copilotAnnotation.lastUrl', normalizedUrl);
        await loadPreviewIntoPanel(panel, context, server, normalizedUrl);
        return;
      }
      case 'openExternal': {
        await vscode.env.openExternal(toExternalUri(resolveTargetInput(message.url)));
        return;
      }
      case 'openMarkdown': {
        await openMarkdownDocument(message.markdown, message.sourceUrl);
        return;
      }
      case 'copyMarkdown': {
        await vscode.env.clipboard.writeText(message.markdown);
        void vscode.window.showInformationMessage('Annotation markdown copied to the clipboard.');
        return;
      }
      case 'sendToCopilot': {
        await sendToCopilot(message.markdown, panel);
        return;
      }
      case 'navigated': {
        try {
          const normalizedUrl = resolveTargetInput(message.url);
          if (currentPanel === panel) {
            currentPreviewTargetUrl = normalizedUrl;
            const resolvedTarget = new URL(normalizedUrl);
            panel.title = `Copilot Annotation: ${getTargetDisplayName(resolvedTarget)}`;
            configurePreviewWatcher(server, resolvedTarget);
          }
          await context.globalState.update('copilotAnnotation.lastUrl', normalizedUrl);
        } catch {
          return;
        }
        return;
      }
      default:
        return;
    }
  });

  return panel;
}

async function loadPreviewIntoPanel(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  server: AnnotationProxyServer,
  targetUrl: string
): Promise<void> {
  const resolvedTarget = new URL(targetUrl);
  const previewUrl = await server.getPreviewUrl(targetUrl);
  const fontAwesomeCssUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'vendor', 'fontawesome', 'all.min.css')
  );

  panel.title = `Copilot Annotation: ${getTargetDisplayName(resolvedTarget)}`;
  panel.webview.html = getPreviewShellHtml(previewUrl, fontAwesomeCssUri.toString(), panel.webview.cspSource);

  if (currentPanel === panel) {
    currentPreviewTargetUrl = targetUrl;
    configurePreviewWatcher(server, resolvedTarget);
  }
}

function shouldAutoReloadOnWorkspaceMutation(): boolean {
  if (!currentPreviewTargetUrl) {
    return false;
  }

  const targetUrl = new URL(currentPreviewTargetUrl);
  return targetUrl.protocol !== 'file:' && isLocalDevelopmentTarget(targetUrl);
}

function isLocalDevelopmentTarget(targetUrl: URL): boolean {
  const hostname = targetUrl.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
    return true;
  }

  if (/^10(?:\.\d{1,3}){3}$/.test(hostname)) {
    return true;
  }

  if (/^192\.168(?:\.\d{1,3}){2}$/.test(hostname)) {
    return true;
  }

  const private172Match = /^172\.(\d{1,3})(?:\.\d{1,3}){2}$/.exec(hostname);
  if (private172Match) {
    const secondOctet = Number(private172Match[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  }

  return false;
}

function configurePreviewWatcher(server: AnnotationProxyServer, targetUrl: URL): void {
  disposeCurrentLocalPreviewWatcher();

  if (targetUrl.protocol !== 'file:') {
    return;
  }

  const targetPath = vscode.Uri.parse(targetUrl.toString()).fsPath;
  const watchRoot = nodePath.dirname(targetPath);
  const pattern = new vscode.RelativePattern(watchRoot, '**/*');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const onChange = () => {
    schedulePreviewReload(server);
  };

  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  currentLocalPreviewWatcher = watcher;
}

function schedulePreviewReload(server: AnnotationProxyServer): void {
  if (!currentPanel || !currentPreviewTargetUrl) {
    return;
  }

  if (scheduledPreviewReload) {
    clearTimeout(scheduledPreviewReload);
  }

  scheduledPreviewReload = setTimeout(() => {
    scheduledPreviewReload = undefined;
    void reloadCurrentPreview(server);
  }, 200);
}

async function reloadCurrentPreview(server: AnnotationProxyServer): Promise<void> {
  if (!currentPanel || !currentPreviewTargetUrl || !extensionContext) {
    return;
  }

  if (isReloadingPreview) {
    queuedPreviewReload = true;
    return;
  }

  isReloadingPreview = true;

  try {
    await loadPreviewIntoPanel(currentPanel, extensionContext, server, currentPreviewTargetUrl);
  } catch (error) {
    console.warn('Copilot Annotation preview auto-reload failed.', error);
  } finally {
    isReloadingPreview = false;

    if (queuedPreviewReload) {
      queuedPreviewReload = false;
      schedulePreviewReload(server);
    }
  }
}

function disposeCurrentLocalPreviewWatcher(): void {
  if (!currentLocalPreviewWatcher) {
    return;
  }

  currentLocalPreviewWatcher.dispose();
  currentLocalPreviewWatcher = undefined;
}

function resetPreviewTracking(): void {
  currentPreviewTargetUrl = undefined;
  disposeCurrentLocalPreviewWatcher();

  if (scheduledPreviewReload) {
    clearTimeout(scheduledPreviewReload);
    scheduledPreviewReload = undefined;
  }

  isReloadingPreview = false;
  queuedPreviewReload = false;
}

async function openMarkdownDocument(markdown: string, sourceUrl: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: [
      `# Copilot Annotation Feedback`,
      '',
      `Source: ${sourceUrl}`,
      '',
      markdown
    ].join('\n')
  });

  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
}