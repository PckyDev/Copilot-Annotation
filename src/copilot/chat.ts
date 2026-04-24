import * as vscode from 'vscode';

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

export async function sendToCopilot(markdown: string, panel: vscode.WebviewPanel): Promise<void> {
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