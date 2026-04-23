import * as nodePath from 'node:path';
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { AnnotationProxyServer } from './proxy/annotationProxyServer';

type WebviewMessage =
  | { type: 'reloadTarget'; url: string }
  | { type: 'openExternal'; url: string }
  | { type: 'openMarkdown'; markdown: string; sourceUrl: string }
  | { type: 'copyMarkdown'; markdown: string }
  | { type: 'sendToCopilot'; markdown: string; sourceUrl: string };

type ExistingChatTarget = {
  kind: 'existing';
  label: string;
  description: string;
  groupIndex: number;
  tabIndex: number;
};

type NewChatTarget = {
  kind: 'new';
  label: string;
  description: string;
};

type ChatTarget = ExistingChatTarget | NewChatTarget;

const NEW_CHAT_COMMAND_CANDIDATES = [
  'vscode.editorChat.start',
  'workbench.action.chat.open'
];

const CHAT_INPUT_FOCUS_COMMAND_CANDIDATES = [
  'workbench.action.chat.focusInput',
  'workbench.panel.chat.view.copilot.focus'
];

const CHAT_SUBMIT_COMMAND_CANDIDATES = [
  'workbench.action.chat.submit',
  'chat.action.submit',
  'workbench.action.quickchat.accept'
];

const PASTE_COMMAND_CANDIDATES = [
  'paste',
  'editor.action.clipboardPasteAction'
];

const FOCUS_EDITOR_GROUP_COMMANDS = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup'
];

const OPEN_EDITOR_AT_INDEX_COMMANDS = [
  'workbench.action.openEditorAtIndex1',
  'workbench.action.openEditorAtIndex2',
  'workbench.action.openEditorAtIndex3',
  'workbench.action.openEditorAtIndex4',
  'workbench.action.openEditorAtIndex5',
  'workbench.action.openEditorAtIndex6',
  'workbench.action.openEditorAtIndex7',
  'workbench.action.openEditorAtIndex8',
  'workbench.action.openEditorAtIndex9'
];

let currentPanel: vscode.WebviewPanel | undefined;
let currentPreviewTargetUrl: string | undefined;
let currentLocalPreviewWatcher: vscode.FileSystemWatcher | undefined;
let scheduledPreviewReload: ReturnType<typeof setTimeout> | undefined;
let isReloadingPreview = false;
let queuedPreviewReload = false;
let currentServer: AnnotationProxyServer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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

        await loadPreviewIntoPanel(currentPanel, server, targetUrl);
        currentPanel.reveal(vscode.ViewColumn.Beside, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown preview error.';
        void vscode.window.showErrorMessage(`Copilot Annotation could not open the preview: ${message}`);
      }
    })
  );
}

export function deactivate(): void {
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

function getInitialTarget(context: vscode.ExtensionContext): string {
  const activeHtmlFile = getActiveHtmlFilePath();
  if (activeHtmlFile) {
    return activeHtmlFile;
  }

  const configuration = vscode.workspace.getConfiguration('copilotAnnotation');
  const configuredUrl = configuration.get<string>('defaultUrl')?.trim();
  const lastUrl = context.globalState.get<string>('copilotAnnotation.lastUrl')?.trim();

  return lastUrl || configuredUrl || 'http://127.0.0.1:3000';
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
      retainContextWhenHidden: true
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
        await loadPreviewIntoPanel(panel, server, normalizedUrl);
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
        await sendToCopilot(message.markdown, message.sourceUrl, panel);
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
  server: AnnotationProxyServer,
  targetUrl: string
): Promise<void> {
  const resolvedTarget = new URL(targetUrl);
  const previewHtml = await server.getPreviewHtml(targetUrl);

  panel.title = `Copilot Annotation: ${getTargetDisplayName(resolvedTarget)}`;
  panel.webview.html = previewHtml;

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
  if (!currentPanel || !currentPreviewTargetUrl) {
    return;
  }

  if (isReloadingPreview) {
    queuedPreviewReload = true;
    return;
  }

  isReloadingPreview = true;

  try {
    await loadPreviewIntoPanel(currentPanel, server, currentPreviewTargetUrl);
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

async function sendToCopilot(
  markdown: string,
  sourceUrl: string,
  panel: vscode.WebviewPanel
): Promise<void> {
  const prompt = buildCopilotPrompt(markdown);

  try {
    const availableCommands = new Set(await vscode.commands.getCommands(true));
    const target = await pickChatTarget();
    if (!target) {
      return;
    }

    await prepareChatTarget(target, availableCommands);
    await insertPromptIntoChat(prompt, availableCommands);
    const didSubmit = await executeFirstAvailableCommand(availableCommands, CHAT_SUBMIT_COMMAND_CANDIDATES);

    void panel.webview.postMessage({
      type: 'copilotAnnotationHostStatus',
      text: didSubmit
        ? 'Feedback sent to Copilot Chat.'
        : 'Feedback inserted into Copilot Chat. Press Enter to send.'
    });
  } catch (error) {
    await vscode.env.clipboard.writeText(prompt);

    const message = error instanceof Error ? error.message : 'Unknown Copilot Chat error.';
    void vscode.window.showWarningMessage(
      `Could not send feedback directly to Copilot Chat: ${message}. The prompt was copied to your clipboard instead.`
    );

    void panel.webview.postMessage({
      type: 'copilotAnnotationHostStatus',
      text: 'Direct send failed. Prompt copied to the clipboard for manual paste into Copilot Chat.'
    });
  }
}

function buildCopilotPrompt(markdown: string): string {
  return [
    'You are working in the current VS Code workspace on website annotation feedback captured by the user.',
    'Treat the following markdown as direct implementation instructions for this project.',
    'Act on the feedback by making the necessary fixes and changes in the codebase where possible instead of only summarizing or suggesting them.',
    'If something is ambiguous or blocked, ask only the minimum necessary clarifying question and otherwise continue with the implementation work.',
    '',
    markdown
  ].join('\n');
}

async function pickChatTarget(): Promise<ChatTarget | undefined> {
  const existingTargets = getOpenChatTargets();
  const newTarget: NewChatTarget = {
    kind: 'new',
    label: 'New Copilot Chat',
    description: 'Open a new editor chat session'
  };

  if (existingTargets.length === 0) {
    return newTarget;
  }

  if (existingTargets.length === 1) {
    return existingTargets[0];
  }

  const selection = await vscode.window.showQuickPick(
    [
      ...existingTargets.map((target) => ({
        label: target.label,
        description: target.description,
        target
      })),
      {
        label: newTarget.label,
        description: newTarget.description,
        target: newTarget
      }
    ],
    {
      title: 'Choose a Copilot Chat Session',
      placeHolder: 'Select the chat session that should receive the feedback'
    }
  );

  return selection?.target;
}

function getOpenChatTargets(): ExistingChatTarget[] {
  return vscode.window.tabGroups.all.flatMap((group, groupIndex) => group.tabs.flatMap((tab, tabIndex) => {
    if (!canFocusTab(groupIndex, tabIndex) || !isLikelyChatTab(tab)) {
      return [];
    }

    return [{
      kind: 'existing' as const,
      label: tab.label,
      description: `Editor group ${groupIndex + 1}, tab ${tabIndex + 1}`,
      groupIndex,
      tabIndex
    }];
  }));
}

function canFocusTab(groupIndex: number, tabIndex: number): boolean {
  return groupIndex >= 0
    && groupIndex < FOCUS_EDITOR_GROUP_COMMANDS.length
    && tabIndex >= 0
    && tabIndex < OPEN_EDITOR_AT_INDEX_COMMANDS.length;
}

function isLikelyChatTab(tab: vscode.Tab): boolean {
  const label = tab.label.trim().toLowerCase();
  const inputTypeName = getTabInputTypeName(tab.input).toLowerCase();

  return inputTypeName.includes('chat')
    || label === 'chat'
    || label.startsWith('chat:')
    || label.includes('copilot chat');
}

function getTabInputTypeName(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return '';
  }

  return Object.getPrototypeOf(input)?.constructor?.name ?? '';
}

async function prepareChatTarget(target: ChatTarget, availableCommands: Set<string>): Promise<void> {
  if (target.kind === 'new') {
    const opened = await executeFirstAvailableCommand(availableCommands, NEW_CHAT_COMMAND_CANDIDATES);
    if (!opened) {
      throw new Error('This VS Code build does not expose a command for opening Copilot Chat from an extension.');
    }
    return;
  }

  await vscode.commands.executeCommand(FOCUS_EDITOR_GROUP_COMMANDS[target.groupIndex]);
  await vscode.commands.executeCommand(OPEN_EDITOR_AT_INDEX_COMMANDS[target.tabIndex]);
}

async function insertPromptIntoChat(prompt: string, availableCommands: Set<string>): Promise<void> {
  await executeFirstAvailableCommand(availableCommands, CHAT_INPUT_FOCUS_COMMAND_CANDIDATES);

  try {
    await vscode.commands.executeCommand('type', { text: prompt });
    return;
  } catch {
    await vscode.env.clipboard.writeText(prompt);
    const pasted = await executeFirstAvailableCommand(availableCommands, PASTE_COMMAND_CANDIDATES);
    if (!pasted) {
      throw new Error('VS Code could not insert text into the selected Copilot Chat session.');
    }
  }
}

async function executeFirstAvailableCommand(
  availableCommands: Set<string>,
  commandIds: readonly string[]
): Promise<boolean> {
  for (const commandId of commandIds) {
    if (!availableCommands.has(commandId)) {
      continue;
    }

    try {
      await vscode.commands.executeCommand(commandId);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

function resolveTargetInput(value: string): string {
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

function toExternalUri(targetUrl: string): vscode.Uri {
  return vscode.Uri.parse(targetUrl);
}

function getTargetDisplayName(targetUrl: URL): string {
  if (targetUrl.protocol === 'file:') {
    const fileName = nodePath.basename(decodeURIComponent(targetUrl.pathname));
    return fileName || 'Local File';
  }

  return targetUrl.host;
}