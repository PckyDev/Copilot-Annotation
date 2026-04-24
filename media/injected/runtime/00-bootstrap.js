// @ts-nocheck

(function () {
  const config = window.__COPILOT_ANNOTATION__;
  if (!config || window.__COPILOT_ANNOTATION_RUNTIME__) {
    return;
  }

  window.__COPILOT_ANNOTATION_RUNTIME__ = true;

  const STYLE_KEYS = [
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'display',
    'position',
    'margin',
    'padding',
    'border',
    'border-radius',
    'width',
    'height'
  ];

  const TOOL_LABELS = {
    text: 'Text',
    element: 'Element',
    multi: 'Multi',
    area: 'Area'
  };

  const state = {
    tool: 'text',
    nextId: 1,
    annotations: [],
    tooltip: null,
    modal: null,
    helper: null,
    toast: null,
    activeAnnotationId: null,
    hoverAnnotationId: null,
    hoverRect: null,
    hoverSelector: null,
    areaDraft: null,
    multiDraft: [],
    multiBox: null,
    multiPointerDown: null,
    areaPointerDown: null,
    pendingDraft: null,
    statusText: 'Ready to annotate.'
  };

  let root;
  let toolbar;
  let layer;
  let lastReportedToolbarState = '';
  let vscodeApi;

  patchNetworkRequests();
  patchHistory();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }

  function bootstrap() {
    if (config.shellToolbar) {
      document.documentElement.dataset.caShellToolbar = 'true';
      document.body.dataset.caShellToolbar = 'true';
    } else {
      toolbar = document.createElement('div');
      toolbar.className = 'ca-toolbar';
      toolbar.innerHTML = [
        '<div class="ca-toolbar__group" data-role="tools"></div>',
        '<div class="ca-toolbar__group ca-toolbar__group--actions" data-role="actions"></div>'
      ].join('');
      document.body.insertBefore(toolbar, document.body.firstChild);
    }

    root = document.createElement('div');
    root.id = 'copilot-annotation-root';
    document.body.appendChild(root);

    layer = document.createElement('div');
    layer.className = 'ca-layer';
    root.appendChild(layer);

    if (!config.shellToolbar) {
      buildToolbar();
    }
    attachGlobalListeners();
    render();
    postToHost('runtimeReady', {});
    reportToolbarState(true);
    postToHost('status', { text: 'Preview ready. Pick a tool and annotate the page.' });
    postToHost('navigated', { url: config.targetUrl });
  }

  function buildToolbar() {
    const toolGroup = toolbar.querySelector('[data-role="tools"]');
    const actionGroup = toolbar.querySelector('[data-role="actions"]');
    const tools = [
      { key: 'text', label: 'Text selection', icon: 'fa-i-cursor' },
      { key: 'element', label: 'Element selection', icon: 'fa-arrow-pointer' },
      { key: 'multi', label: 'Multi-select', icon: 'fa-layer-group' },
      { key: 'area', label: 'Area selection', icon: 'fa-crop' }
    ];
    const actions = [
      { key: 'view', label: 'View feedback', icon: 'fa-eye', quiet: true },
      { key: 'clear', label: 'Clear annotations', icon: 'fa-trash-can', quiet: true },
      { key: 'send', label: 'Send Feedback', icon: 'fa-paper-plane', quiet: false }
    ];

    for (const tool of tools) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ca-chip ca-chip--tool';
      button.innerHTML = `<i class="fa-solid ${tool.icon}" aria-hidden="true"></i>`;
      button.dataset.tool = tool.key;
      button.setAttribute('aria-label', tool.label);
      button.title = tool.label;
      button.setAttribute('aria-pressed', String(state.tool === tool.key));
      button.addEventListener('click', () => {
        activateTool(tool.key);
      });
      toolGroup.appendChild(button);
    }

    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action.quiet ? 'ca-chip ca-chip--quiet' : 'ca-chip ca-chip--primary';
      button.setAttribute('aria-label', action.label);
      button.title = action.label;
      button.innerHTML = action.key === 'send'
        ? `<span>${escapeHtml(action.label)}</span><i class="fa-solid ${action.icon}" aria-hidden="true"></i>`
        : `<i class="fa-solid ${action.icon}" aria-hidden="true"></i>`;
      button.addEventListener('click', () => {
        if (action.key === 'view') {
          openMarkdownModal();
          return;
        }

        if (action.key === 'clear') {
          clearAnnotations();
          return;
        }

        if (action.key === 'send') {
          sendMarkdownToHost();
        }
      });
      actionGroup.appendChild(button);
    }
  }

  function attachGlobalListeners() {
    document.addEventListener('mouseup', onDocumentMouseUp, true);
    document.addEventListener('mousemove', onDocumentMouseMove, true);
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('scroll', render, { passive: true, capture: true });
    window.addEventListener('resize', render);
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message && message.type === 'copilotAnnotationHostCommand') {
        handleHostCommand(message);
        return;
      }

      if (!message || message.type !== 'copilotAnnotationHostStatus') {
        return;
      }
      showToast(message.text);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (state.modal) {
          closeModal();
          return;
        }

        clearDraftState();
        render();
      }

      if (state.tool === 'multi' && event.key === 'Enter' && state.multiDraft.length > 0 && !state.modal) {
        event.preventDefault();
        createMultiAnnotationFromDraft();
      }
    }, true);
  }

  function handleHostCommand(message) {
    switch (message.command) {
      case 'setTool':
        if (typeof message.tool === 'string') {
          activateTool(message.tool);
        }
        return;
      case 'viewFeedback':
        openMarkdownModal();
        return;
      case 'clearAnnotations':
        clearAnnotations();
        return;
      case 'sendFeedback':
        sendMarkdownToHost();
        return;
      case 'requestToolbarState':
        reportToolbarState(true);
        return;
      default:
        return;
    }
  }

  function activateTool(tool, announce = true) {
    if (!Object.prototype.hasOwnProperty.call(TOOL_LABELS, tool)) {
      return;
    }

    state.tool = tool;
    state.hoverRect = null;
    clearDraftState();
    render();

    if (announce) {
      showToast(`${TOOL_LABELS[tool]} mode active.`);
    }
  }

