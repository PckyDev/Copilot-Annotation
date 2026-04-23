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
    toolbar = document.createElement('div');
    toolbar.className = 'ca-toolbar';
    toolbar.innerHTML = [
      '<div class="ca-toolbar__group" data-role="tools"></div>',
      '<div class="ca-toolbar__group ca-toolbar__group--actions" data-role="actions"></div>'
    ].join('');
    document.body.insertBefore(toolbar, document.body.firstChild);

    root = document.createElement('div');
    root.id = 'copilot-annotation-root';
    document.body.appendChild(root);

    layer = document.createElement('div');
    layer.className = 'ca-layer';
    root.appendChild(layer);

    buildToolbar();
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
    document.body.addEventListener('scroll', render, { passive: true });
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

  function onDocumentMouseDown(event) {
    const chromeAnnotationId = getAnnotationIdFromChromeTarget(event.target);
    if (chromeAnnotationId != null) {
      event.preventDefault();
      event.stopPropagation();
      clearDraftState();
      clearTooltip();
      openAnnotation(chromeAnnotationId);
      return;
    }

    if (state.modal && state.modal.kind === 'annotation' && state.modal.panel && !state.modal.panel.contains(event.target)) {
      closeModal();
    }

    if (isAnnotationChrome(event.target)) {
      return;
    }

    const pagePoint = toPagePoint(event.clientX, event.clientY);

    if (state.tool === 'area') {
      state.areaPointerDown = pagePoint;
      state.areaDraft = { x: pagePoint.x, y: pagePoint.y, width: 0, height: 0 };
      render();
      event.preventDefault();
      return;
    }

    if (state.tool === 'multi') {
      state.multiPointerDown = pagePoint;
      state.multiBox = null;
    }
  }

  function onDocumentMouseMove(event) {
    if (isAnnotationChrome(event.target)) {
      const shouldClearAnnotationHover = state.hoverAnnotationId != null
        && !isMarkerTargetForAnnotation(event.target, state.hoverAnnotationId);

      if (state.hoverRect || shouldClearAnnotationHover) {
        state.hoverRect = null;
        if (shouldClearAnnotationHover) {
          state.hoverAnnotationId = null;
          clearTooltip();
        }
        render(true);
      }
      return;
    }

    const hadHoveredAnnotation = state.hoverAnnotationId != null;
    if (hadHoveredAnnotation) {
      state.hoverAnnotationId = null;
      clearTooltip();
    }

    const pagePoint = toPagePoint(event.clientX, event.clientY);

    if (state.tool === 'area' && state.areaPointerDown) {
      state.areaDraft = normalizeRect({
        x: state.areaPointerDown.x,
        y: state.areaPointerDown.y,
        width: pagePoint.x - state.areaPointerDown.x,
        height: pagePoint.y - state.areaPointerDown.y
      });
      render();
      return;
    }

    if (state.tool === 'multi' && state.multiPointerDown) {
      const width = pagePoint.x - state.multiPointerDown.x;
      const height = pagePoint.y - state.multiPointerDown.y;
      if (Math.abs(width) > 6 || Math.abs(height) > 6) {
        state.multiBox = normalizeRect({
          x: state.multiPointerDown.x,
          y: state.multiPointerDown.y,
          width,
          height
        });
        render();
      }
      return;
    }

    if (state.tool === 'element' || state.tool === 'multi') {
      const element = getSelectableElement(event.target);
      state.hoverRect = element ? firstRectForElement(element) : null;
      render();
      return;
    }

    if (hadHoveredAnnotation) {
      render();
    }
  }

  function onDocumentMouseUp(event) {
    if (isAnnotationChrome(event.target)) {
      return;
    }

    if (state.tool === 'text') {
      captureTextSelection();
      return;
    }

    if (state.tool === 'area' && state.areaPointerDown && state.areaDraft) {
      const rect = normalizeRect(state.areaDraft);
      state.areaPointerDown = null;
      if (rect.width >= 12 && rect.height >= 12) {
        openDraftModal({
          type: 'area',
          rect,
          summary: 'Area Selection',
          styles: null,
          location: `x: ${Math.round(rect.x)}px, y: ${Math.round(rect.y)}px`,
          details: {
            areaSize: `width: ${Math.round(rect.width)}px, height: ${Math.round(rect.height)}px`
          }
        });
      } else {
        state.areaDraft = null;
      }
      render();
      return;
    }

    if (state.tool === 'multi' && state.multiPointerDown) {
      if (state.multiBox && state.multiBox.width >= 10 && state.multiBox.height >= 10) {
        const elements = collectElementsInBox(state.multiBox);
        state.multiPointerDown = null;
        state.multiBox = null;
        if (elements.length > 0) {
          state.multiDraft = dedupeElements(elements);
          render();
          showMultiHelper();
        } else {
          render();
        }
        event.preventDefault();
        return;
      }

      state.multiPointerDown = null;
      state.multiBox = null;
    }
  }

  function onDocumentClick(event) {
    const chromeAnnotationId = getAnnotationIdFromChromeTarget(event.target);
    if (chromeAnnotationId != null) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (isAnnotationChrome(event.target)) {
      return;
    }

    const element = getSelectableElement(event.target);
    const existingAnnotation = element ? findAnnotationForElement(element) : null;
    const shouldOpenExistingAnnotation = state.tool === 'element' || (state.tool === 'multi' && !event.shiftKey);

    if (existingAnnotation && shouldOpenExistingAnnotation) {
      event.preventDefault();
      event.stopPropagation();
      clearDraftState();
      clearTooltip();
      openAnnotation(existingAnnotation.id);
      return;
    }

    if (state.tool === 'element') {
      if (!element) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      createElementDraft(element, 'element');
      return;
    }

    if (state.tool === 'multi') {
      if (!element || state.multiBox) {
        return;
      }

      if (!event.shiftKey) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const existingIndex = state.multiDraft.findIndex((entry) => entry.selector === createCssPath(element));
      if (existingIndex >= 0) {
        state.multiDraft.splice(existingIndex, 1);
      } else {
        state.multiDraft.push(createElementSnapshot(element));
      }

      render();
      if (state.multiDraft.length > 0) {
        showMultiHelper();
      } else {
        clearHelper();
      }
    }
  }

  function captureTextSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (isAnnotationChrome(range.commonAncestorContainer)) {
      return;
    }

    const selectedText = selection.toString().trim();
    if (!selectedText) {
      return;
    }

    const parentElement = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const anchorElement = getSelectableElement(parentElement);
    if (!anchorElement) {
      return;
    }

    const rects = clientRectsToPageRects(range.getClientRects());
    if (rects.length === 0) {
      return;
    }

    selection.removeAllRanges();

    openDraftModal({
      type: 'text',
      rects,
      element: createElementSnapshot(anchorElement),
      selectedText,
      summary: `${anchorElement.tagName.toLowerCase()}: "${truncate(getVisibleText(anchorElement), 40)}"`,
      styles: captureStyles(anchorElement),
      location: createCssPath(anchorElement),
      details: {
        selectedText
      }
    });
  }

  function createElementDraft(element, type) {
    const snapshot = createElementSnapshot(element);
    openDraftModal({
      type,
      rects: snapshot.rects,
      element: snapshot,
      summary: snapshot.label,
      styles: snapshot.styles,
      location: snapshot.selector,
      details: {}
    });
  }

  function createMultiAnnotationFromDraft() {
    const elements = state.multiDraft.slice();
    if (elements.length === 0) {
      return;
    }

    const combinedRects = elements.flatMap((element) => element.rects);
    openDraftModal({
      type: 'multi',
      rects: combinedRects,
      elements,
      summary: `${elements.length} elements: ${elements.map((element) => element.label).join(', ')}`,
      styles: elements[0] ? elements[0].styles : null,
      location: null,
      details: {
        locations: elements.map((element) => element.selector)
      }
    });
  }

  function openDraftModal(draft) {
    state.pendingDraft = draft;
    clearHelper();
    showAnnotationModal({
      mode: 'create',
      title: draft.type === 'text' ? 'Text Annotation' : draft.type === 'element' ? 'Element Annotation' : draft.type === 'multi' ? 'Multi-Select Annotation' : 'Area Annotation',
      subtitle: 'Capture what needs to change and why.',
      initialComment: ''
    }, (comment) => {
      const annotation = materializeAnnotation(draft, comment);
      state.annotations.push(annotation);
      state.nextId += 1;
      clearDraftState();
      render();
      showToast(`Annotation ${annotation.id} saved.`);
    });
  }

  function showAnnotationModal(configModal, onSave, existingAnnotation) {
    closeModal();

    const modal = document.createElement('div');
    modal.className = 'ca-editor-panel';

    const context = existingAnnotation || state.pendingDraft;
    state.activeAnnotationId = existingAnnotation ? existingAnnotation.id : null;
    const selectionMarkup = renderSelectionSummary(context);
    const stylesMarkup = context.styles
      ? `<details class="ca-styles"><summary>Computed styles</summary><pre>${escapeHtml(formatStyles(context.styles))}</pre></details>`
      : '';

    modal.innerHTML = [
      '<div class="ca-editor-panel__section">',
      selectionMarkup,
      stylesMarkup,
      '</div>',
      '<div class="ca-editor-panel__section">',
      `  <textarea id="ca-comment" class="ca-field" placeholder="Describe the issue or suggestion...">${escapeHtml(configModal.initialComment)}</textarea>`,
      '</div>',
      '<div class="ca-editor-panel__footer">',
      '  <div class="ca-button-row">',
      `    ${existingAnnotation ? '<button type="button" class="ca-button ca-button--danger" data-action="remove">Remove</button>' : ''}`,
      '  </div>',
      '  <div class="ca-button-row">',
      '    <button type="button" class="ca-button ca-button--secondary" data-action="cancel">Cancel</button>',
      '    <button type="button" class="ca-button" data-action="save">Save</button>',
      '  </div>',
      '</div>'
    ].join('');

    modal.querySelector('[data-action="cancel"]').addEventListener('click', closeModal);
    modal.querySelector('[data-action="save"]').addEventListener('click', () => {
      const comment = modal.querySelector('#ca-comment').value.trim();
      if (!comment) {
        showToast('Add feedback before saving.');
        return;
      }

      onSave(comment);
      closeModal();
    });

    const removeButton = modal.querySelector('[data-action="remove"]');
    if (removeButton && existingAnnotation) {
      removeButton.addEventListener('click', () => {
        const index = state.annotations.findIndex((annotation) => annotation.id === existingAnnotation.id);
        if (index >= 0) {
          state.annotations.splice(index, 1);
        }
        closeModal();
        render();
        showToast(`Annotation ${existingAnnotation.id} removed.`);
      });
    }

    state.modal = { kind: 'annotation', panel: modal, context };
    root.appendChild(modal);
    render(true);
    positionAnnotationPanel(modal, context);
    requestAnimationFrame(() => {
      if (state.modal && state.modal.kind === 'annotation' && state.modal.panel === modal) {
        positionAnnotationPanel(modal, context);
      }
    });
    modal.querySelector('#ca-comment').focus();
  }

  function renderSelectionSummary(context) {
    const parts = [];

    if (context.summary) {
      parts.push(`<div class="ca-selection-card__title">${escapeHtml(context.summary)}</div>`);
    }

    if (context.details && context.details.selectedText) {
      parts.push(`<pre class="ca-selection-card__preview">${escapeHtml(context.details.selectedText)}</pre>`);
    } else if (context.details && context.details.areaSize) {
      parts.push(`<div class="ca-selection-card__preview">${escapeHtml(context.details.areaSize)}</div>`);
    }

    return `<div class="ca-selection-card">${parts.join('')}</div>`;
  }

  function openAnnotation(annotationId) {
    const annotation = state.annotations.find((item) => item.id === annotationId);
    if (!annotation) {
      return;
    }

    state.activeAnnotationId = annotation.id;
    render();

    showAnnotationModal({
      mode: 'edit',
      title: `Annotation ${annotation.id}`,
      subtitle: annotation.toolLabel,
      initialComment: annotation.comment
    }, (comment) => {
      annotation.comment = comment;
      render();
      showToast(`Annotation ${annotation.id} updated.`);
    }, annotation);
  }

  function closeModal() {
    if (!state.modal) {
      return;
    }

    if (state.modal.backdrop) {
      state.modal.backdrop.remove();
    }
    state.modal.panel.remove();
    state.modal = null;
    state.activeAnnotationId = null;
    state.hoverAnnotationId = null;
    state.pendingDraft = null;
    clearTooltip();
    render(true);
  }

  function clearAnnotations() {
    if (state.annotations.length === 0) {
      showToast('There are no annotations to clear.');
      return;
    }

    openConfirmModal({
      title: 'Clear Annotations',
      subtitle: `Remove ${state.annotations.length} annotation${state.annotations.length === 1 ? '' : 's'} from this page?`,
      confirmLabel: 'Clear All',
      confirmButtonClassName: 'ca-button ca-button--danger',
      onConfirm: () => {
        state.annotations = [];
        state.nextId = 1;
        clearDraftState();
        render();
        showToast('All annotations cleared.');
      }
    });
  }

  function clearDraftState() {
    state.hoverRect = null;
    state.areaDraft = null;
    state.areaPointerDown = null;
    state.multiBox = null;
    state.multiPointerDown = null;
    state.multiDraft = [];
    state.pendingDraft = null;
    clearHelper();
  }

  function clearHelper() {
    if (state.helper) {
      state.helper.remove();
      state.helper = null;
    }
  }

  function showMultiHelper() {
    clearHelper();
    const helper = document.createElement('div');
    helper.className = 'ca-helper';
    helper.innerHTML = [
      `<span>${state.multiDraft.length} element${state.multiDraft.length === 1 ? '' : 's'} selected.</span>`,
      '<button type="button">Comment</button>'
    ].join('');
    helper.querySelector('button').addEventListener('click', createMultiAnnotationFromDraft);
    state.helper = helper;
    root.appendChild(helper);
  }

  function openMarkdownModal() {
    closeModal();
    const markdown = generateMarkdown();
    const sourceUrl = getCurrentTargetUrl();

    const backdrop = document.createElement('div');
    backdrop.className = 'ca-modal-backdrop';
    backdrop.addEventListener('click', closeModal);

    const modal = document.createElement('div');
    modal.className = 'ca-modal';
    modal.innerHTML = [
      '<div class="ca-modal__header">',
      '  <div>',
      '    <h2 class="ca-modal__title">Feedback Markdown</h2>',
      '    <p class="ca-modal__subtitle">Review everything before sending it to Copilot.</p>',
      '  </div>',
      '  <button type="button" class="ca-modal__close" aria-label="Close">&times;</button>',
      '</div>',
      '<div class="ca-modal__body">',
      `  <div class="ca-preview">${escapeHtml(markdown)}</div>`,
      '</div>',
      '<div class="ca-modal__footer">',
      '  <div class="ca-button-row">',
      '    <button type="button" class="ca-button ca-button--secondary" data-action="open">Open Draft</button>',
      '    <button type="button" class="ca-button ca-button--secondary" data-action="copy">Copy</button>',
      '  </div>',
      '  <div class="ca-button-row">',
      '    <button type="button" class="ca-button ca-button--secondary" data-action="close">Close</button>',
      '    <button type="button" class="ca-button" data-action="send">Send To Copilot</button>',
      '  </div>',
      '</div>'
    ].join('');

    modal.querySelector('.ca-modal__close').addEventListener('click', closeModal);
    modal.querySelector('[data-action="close"]').addEventListener('click', closeModal);
    modal.querySelector('[data-action="open"]').addEventListener('click', () => {
      postToHost('openMarkdown', { markdown, sourceUrl });
      showToast('Markdown draft opened in VS Code.');
    });
    modal.querySelector('[data-action="copy"]').addEventListener('click', () => {
      postToHost('copyMarkdown', { markdown, sourceUrl });
      showToast('Markdown copied in VS Code.');
    });
    modal.querySelector('[data-action="send"]').addEventListener('click', () => {
      sendMarkdownToHost();
      closeModal();
    });

    state.modal = { kind: 'dialog', backdrop, panel: modal };
    root.appendChild(backdrop);
    root.appendChild(modal);
  }

  function openConfirmModal(configModal) {
    closeModal();

    const backdrop = document.createElement('div');
    backdrop.className = 'ca-modal-backdrop';
    backdrop.addEventListener('click', closeModal);

    const modal = document.createElement('div');
    modal.className = 'ca-modal';
    modal.innerHTML = [
      '<div class="ca-modal__header">',
      '  <div>',
      `    <h2 class="ca-modal__title">${escapeHtml(configModal.title)}</h2>`,
      `    <p class="ca-modal__subtitle">${escapeHtml(configModal.subtitle)}</p>`,
      '  </div>',
      '  <button type="button" class="ca-modal__close" aria-label="Close">&times;</button>',
      '</div>',
      '<div class="ca-modal__body">',
      '  <p class="ca-modal__message">This cannot be undone.</p>',
      '</div>',
      '<div class="ca-modal__footer">',
      '  <div class="ca-button-row"></div>',
      '  <div class="ca-button-row">',
      '    <button type="button" class="ca-button ca-button--secondary" data-action="cancel">Cancel</button>',
      `    <button type="button" class="${escapeHtml(configModal.confirmButtonClassName || 'ca-button')}" data-action="confirm">${escapeHtml(configModal.confirmLabel || 'Confirm')}</button>`,
      '  </div>',
      '</div>'
    ].join('');

    modal.querySelector('.ca-modal__close').addEventListener('click', closeModal);
    modal.querySelector('[data-action="cancel"]').addEventListener('click', closeModal);
    modal.querySelector('[data-action="confirm"]').addEventListener('click', () => {
      closeModal();
      configModal.onConfirm();
    });

    state.modal = { kind: 'dialog', backdrop, panel: modal };
    root.appendChild(backdrop);
    root.appendChild(modal);
  }

  function sendMarkdownToHost() {
    const markdown = generateMarkdown();
    postToHost('sendToCopilot', { markdown, sourceUrl: getCurrentTargetUrl() });
  }

  function materializeAnnotation(draft, comment) {
    const id = state.nextId;
    const common = {
      id,
      comment,
      styles: draft.styles,
      summary: draft.summary,
      toolLabel: toolLabelForType(draft.type)
    };

    if (draft.type === 'text') {
      return {
        ...common,
        kind: 'text',
        rects: draft.rects,
        selector: draft.element.selector,
        elementLabel: draft.element.label,
        selectedText: draft.selectedText,
        details: draft.details,
        markerKind: 'normal'
      };
    }

    if (draft.type === 'element') {
      return {
        ...common,
        kind: 'element',
        rects: draft.rects,
        selector: draft.element.selector,
        elementLabel: draft.element.label,
        details: draft.details,
        markerKind: 'normal'
      };
    }

    if (draft.type === 'multi') {
      return {
        ...common,
        kind: 'multi',
        rects: draft.rects,
        elements: draft.elements,
        details: draft.details,
        markerKind: 'group'
      };
    }

    return {
      ...common,
      kind: 'area',
      rects: [draft.rect],
      location: draft.location,
      details: draft.details,
      markerKind: 'group'
    };
  }

  function render(preserveMarkers = false) {
    if (!layer || !toolbar) {
      return;
    }

    if (!preserveMarkers) {
      root.querySelectorAll('.ca-marker').forEach((marker) => marker.remove());
    }
    layer.innerHTML = '';
    renderToolbarState();

    if (state.modal && state.modal.kind === 'annotation') {
      positionAnnotationPanel(state.modal.panel, state.modal.context);
    }

    const visibleAnnotationId = state.hoverAnnotationId ?? state.activeAnnotationId;
    const visibleAnnotation = visibleAnnotationId != null
      ? state.annotations.find((entry) => entry.id === visibleAnnotationId)
      : null;

    if (visibleAnnotation) {
      renderHoverRects(
        visibleAnnotation.rects,
        visibleAnnotation.markerKind === 'group' ? 'multi' : visibleAnnotation.kind,
        true,
        visibleAnnotation.id
      );
    }

    if (!preserveMarkers) {
      for (const annotation of state.annotations) {
        renderAnnotation(annotation);
      }
    }

    if (state.hoverRect && (state.tool === 'element' || state.tool === 'multi')) {
      renderLiveOutline(state.hoverRect, state.tool === 'multi' ? 'multi' : 'element');
    }

    if (state.areaDraft) {
      renderLiveOutline(state.areaDraft, 'area');
    }

    if (state.multiBox) {
      renderLiveOutline(state.multiBox, 'multi');
    }

    if (state.multiDraft.length > 0) {
      for (const snapshot of state.multiDraft) {
        renderHoverRects(snapshot.rects, 'multi');
      }
    }
  }

  function renderToolbarState() {
    toolbar.querySelectorAll('[data-tool]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.tool === state.tool));
    });
    reportToolbarState();
  }

  function reportToolbarState(force = false) {
    const nextState = `${state.tool}:${state.annotations.length}`;
    if (!force && nextState === lastReportedToolbarState) {
      return;
    }

    lastReportedToolbarState = nextState;
    postToHost('toolbarState', {
      tool: state.tool,
      annotationCount: state.annotations.length
    });
  }

  function renderAnnotation(annotation) {
    const markerRect = combineRects(annotation.rects);
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'ca-marker';
    marker.dataset.annotationId = String(annotation.id);
    marker.dataset.kind = annotation.markerKind === 'group' ? annotation.kind : 'element';
    marker.textContent = String(annotation.id);
    positionNode(marker, markerRect.x + markerRect.width / 2 - 15, markerRect.y - 15, 30, 30);
    marker.addEventListener('mouseenter', () => {
      state.hoverAnnotationId = annotation.id;
      renderTooltip(annotation, markerRect);
      render(true);
    });
    marker.addEventListener('mouseleave', () => {
      state.hoverAnnotationId = null;
      clearTooltip();
      render(true);
    });
    marker.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearTooltip();
      openAnnotation(annotation.id);
    });
    root.appendChild(marker);
  }

  function renderHoverRects(rects, kind, solid = true, annotationId = null) {
    for (const rect of rects) {
      const node = document.createElement('div');
      node.className = solid ? 'ca-rect' : 'ca-hover';
      node.dataset.kind = kind;
      if (annotationId != null) {
        node.dataset.annotationId = String(annotationId);
      }
      positionNode(node, rect.x, rect.y, rect.width, rect.height);
      layer.appendChild(node);
    }
  }

  function renderLiveOutline(rect, kind) {
    const node = document.createElement('div');
    node.className = 'ca-live-outline';
    node.dataset.kind = kind;
    positionNode(node, rect.x, rect.y, rect.width, rect.height);
    layer.appendChild(node);
  }

  function renderTooltip(annotation, rect) {
    clearTooltip();
    const tooltip = document.createElement('div');
    tooltip.className = 'ca-tooltip';
    tooltip.innerHTML = [
      `<strong>${escapeHtml(annotation.toolLabel)}</strong>`,
      `<div>${escapeHtml(annotation.comment)}</div>`
    ].join('');
    state.tooltip = tooltip;
    root.appendChild(tooltip);

    requestAnimationFrame(() => {
      const viewportRect = pageRectToViewportRect(rect);
      const bounds = tooltip.getBoundingClientRect();
      const viewportBounds = getScrollViewportRect();
      let left = viewportRect.x + viewportRect.width / 2 - bounds.width / 2;
      let top = viewportRect.y - bounds.height - 16;

      if (left < viewportBounds.left + 12) {
        left = viewportBounds.left + 12;
      }
      if (left + bounds.width > viewportBounds.left + viewportBounds.width - 12) {
        left = viewportBounds.left + viewportBounds.width - bounds.width - 12;
      }
      if (top < viewportBounds.top + 12) {
        top = viewportRect.y + viewportRect.height + 12;
      }

      positionViewportNode(tooltip, left, top, bounds.width, bounds.height);
    });
  }

  function clearTooltip() {
    if (state.tooltip) {
      state.tooltip.remove();
      state.tooltip = null;
    }
  }

  function showToast(text) {
    if (state.toast) {
      state.toast.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'ca-toast';
    toast.textContent = text;
    state.toast = toast;
    root.appendChild(toast);
    window.setTimeout(() => {
      if (state.toast === toast) {
        toast.remove();
        state.toast = null;
      }
    }, 2400);
  }

  function getContextRects(context) {
    if (!context) {
      return [];
    }

    if (Array.isArray(context.rects) && context.rects.length > 0) {
      return context.rects;
    }

    if (context.rect) {
      return [context.rect];
    }

    return [];
  }

  function getContextAnchorRect(context) {
    const rects = getContextRects(context);
    if (rects.length > 0) {
      return combineRects(rects);
    }

    const scroll = getScrollOffsets();
    return {
      x: scroll.left + 12,
      y: scroll.top + 12,
      width: 0,
      height: 0
    };
  }

  function positionAnnotationPanel(panel, context) {
    const bounds = panel.getBoundingClientRect();
    const anchorRect = pageRectToViewportRect(getContextAnchorRect(context));
    const viewportBounds = getScrollViewportRect();
    const gutter = 12;
    const minLeft = viewportBounds.left + gutter;
    const maxLeft = Math.max(minLeft, viewportBounds.left + viewportBounds.width - bounds.width - gutter);
    const minTop = viewportBounds.top + gutter;
    const maxTop = Math.max(minTop, viewportBounds.top + viewportBounds.height - bounds.height - gutter);

    let left = anchorRect.x + anchorRect.width + gutter;
    if (left > maxLeft) {
      left = anchorRect.x - bounds.width - gutter;
    }
    if (left < minLeft) {
      left = Math.min(maxLeft, Math.max(minLeft, anchorRect.x + anchorRect.width / 2 - bounds.width / 2));
    }

    let top = anchorRect.y;
    if (top > maxTop) {
      top = maxTop;
    }
    if (top < minTop) {
      top = anchorRect.y + anchorRect.height + gutter;
    }
    if (top > maxTop) {
      top = anchorRect.y - bounds.height - gutter;
    }
    if (top < minTop) {
      top = minTop;
    }

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function generateMarkdown() {
    const currentTargetUrl = getCurrentTargetUrl();
    const lines = [
      '# Copilot Annotation Feedback',
      '',
      `**Page**: ${currentTargetUrl}`,
      `**Viewport**: ${window.innerWidth}x${window.innerHeight}`,
      ''
    ];

    if (state.annotations.length === 0) {
      lines.push('_No annotations captured yet._');
      return lines.join('\n');
    }

    for (const annotation of state.annotations) {
      if (annotation.kind === 'text') {
        lines.push(`### ${annotation.id}. ${annotation.elementLabel}: "${truncate(annotation.elementLabel, 40)}"`);
        lines.push(`**Location**: ${annotation.selector}`);
        lines.push(`**Selected Text**: "${annotation.selectedText}"`);
        lines.push(`**Feedback**: ${annotation.comment}`);
        lines.push('');
        continue;
      }

      if (annotation.kind === 'element') {
        lines.push(`### ${annotation.id}. ${annotation.elementLabel}`);
        lines.push(`**Location**: ${annotation.selector}`);
        lines.push(`**Feedback**: ${annotation.comment}`);
        lines.push('');
        continue;
      }

      if (annotation.kind === 'multi') {
        lines.push(`### ${annotation.id}. ${annotation.elements.length} elements: ${annotation.elements.map((element) => element.label).join(', ')}`);
        lines.push('**Locations**:');
        annotation.elements.forEach((element, index) => {
          lines.push(`${index + 1}. ${element.selector}`);
        });
        lines.push(`**Feedback**: ${annotation.comment}`);
        lines.push('');
        continue;
      }

      lines.push(`### ${annotation.id}. Area Selection`);
      lines.push(`**Location**: ${annotation.location}`);
      lines.push(`**Area Size**: ${annotation.details.areaSize}`);
      lines.push(`**Feedback**: ${annotation.comment}`);
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  function patchNetworkRequests() {
    const originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      if (input instanceof Request) {
        const proxiedUrl = toProxyUrl(input.url);
        const request = new Request(proxiedUrl, input);
        return originalFetch(init ? new Request(request, init) : request);
      }

      return originalFetch(toProxyUrl(String(input)), init);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      const proxiedUrl = toProxyUrl(String(url));
      return originalOpen.call(this, method, proxiedUrl, true);
    };
  }

  function patchHistory() {
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);

    history.pushState = function (stateValue, unused, url) {
      const result = originalPushState(stateValue, unused, rewriteHistoryUrl(url));
      postToHost('navigated', { url: getCurrentTargetUrl() });
      return result;
    };

    history.replaceState = function (stateValue, unused, url) {
      const result = originalReplaceState(stateValue, unused, rewriteHistoryUrl(url));
      postToHost('navigated', { url: getCurrentTargetUrl() });
      return result;
    };

    window.addEventListener('popstate', () => {
      postToHost('navigated', { url: getCurrentTargetUrl() });
    });
  }

  function rewriteHistoryUrl(url) {
    if (!url) {
      return url;
    }

    return toProxyUrl(String(url));
  }

  function toProxyUrl(value) {
    if (!value || isSpecialUrl(value)) {
      return value;
    }

    const resolved = new URL(value, getCurrentTargetUrl());
    if (isSameTarget(resolved)) {
      return `${config.proxyOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`;
    }

    return resolved.toString();
  }

  function getCurrentTargetUrl() {
    try {
      const current = new URL(window.location.href);
      if (current.origin === config.proxyOrigin) {
        return toTargetUrl(current.toString());
      }
    } catch {
      return config.targetUrl;
    }

    return config.targetUrl;
  }

  function toTargetUrl(value) {
    try {
      const current = new URL(value, window.location.href);
      if (current.origin === config.proxyOrigin) {
        if (config.targetScheme === 'file:') {
          return new URL(`${current.pathname}${current.search}${current.hash}`, 'file://').toString();
        }

        return `${config.targetOrigin}${current.pathname}${current.search}${current.hash}`;
      }
      return current.toString();
    } catch {
      return config.targetUrl;
    }
  }

  function isSameTarget(resolved) {
    if (config.targetScheme === 'file:') {
      return resolved.protocol === 'file:';
    }

    return resolved.origin === config.targetOrigin;
  }

  function isSpecialUrl(value) {
    return value.startsWith('data:')
      || value.startsWith('blob:')
      || value.startsWith('mailto:')
      || value.startsWith('tel:')
      || value.startsWith('javascript:')
      || value.startsWith('#');
  }

  function collectElementsInBox(box) {
    const candidates = Array.from(document.body.querySelectorAll('*'));
    return candidates.filter((element) => {
      if (isAnnotationChrome(element)) {
        return false;
      }

      const rect = firstRectForElement(element);
      return rect && intersects(rect, box);
    });
  }

  function createElementSnapshot(element) {
    return {
      selector: createCssPath(element),
      label: describeElement(element),
      rects: rectsFromElement(element),
      styles: captureStyles(element)
    };
  }

  function rectsFromElement(element) {
    return clientRectsToPageRects(element.getClientRects());
  }

  function captureStyles(element) {
    const computed = window.getComputedStyle(element);
    const styles = {};
    for (const key of STYLE_KEYS) {
      styles[key] = computed.getPropertyValue(key);
    }
    return styles;
  }

  function clientRectsToPageRects(rectList) {
    return Array.from(rectList)
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => viewportRectToPageRect(rect));
  }

  function firstRectForElement(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    return viewportRectToPageRect(rect);
  }

  function combineRects(rects) {
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function normalizeRect(rect) {
    const x = rect.width < 0 ? rect.x + rect.width : rect.x;
    const y = rect.height < 0 ? rect.y + rect.height : rect.y;
    return {
      x,
      y,
      width: Math.abs(rect.width),
      height: Math.abs(rect.height)
    };
  }

  function positionNode(node, pageX, pageY, width, height) {
    const viewportPoint = pagePointToViewportPoint(pageX, pageY);
    node.style.left = `${viewportPoint.x}px`;
    node.style.top = `${viewportPoint.y}px`;
    node.style.width = `${Math.max(width, 0)}px`;
    node.style.height = `${Math.max(height, 0)}px`;
  }

  function positionViewportNode(node, viewportX, viewportY, width, height) {
    node.style.left = `${viewportX}px`;
    node.style.top = `${viewportY}px`;
    node.style.width = `${Math.max(width, 0)}px`;
    node.style.height = `${Math.max(height, 0)}px`;
  }

  function getSelectableElement(node) {
    if (!node) {
      return null;
    }

    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) {
      return null;
    }

    const selectable = element.closest('body *');
    if (!selectable || isAnnotationChrome(selectable)) {
      return null;
    }

    return selectable;
  }

  function findAnnotationForElement(element) {
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName.toLowerCase() !== 'body') {
      const selector = createCssPath(current);
      const annotation = findAnnotationBySelector(selector);
      if (annotation) {
        return annotation;
      }
      current = current.parentElement;
    }

    return null;
  }

  function findAnnotationBySelector(selector) {
    for (let index = state.annotations.length - 1; index >= 0; index -= 1) {
      const annotation = state.annotations[index];
      if (annotation.selector === selector) {
        return annotation;
      }

      if (Array.isArray(annotation.elements) && annotation.elements.some((entry) => entry.selector === selector)) {
        return annotation;
      }
    }

    return null;
  }

  function isAnnotationChrome(node) {
    const element = toEventElement(node);
    return !!element && (
      element.id === 'copilot-annotation-root'
      || (element.closest && element.closest('#copilot-annotation-root, .ca-toolbar'))
    );
  }

  function isMarkerTargetForAnnotation(node, annotationId) {
    const element = toEventElement(node);
    if (!element || !element.closest) {
      return false;
    }

    const annotationTarget = element.closest('[data-annotation-id]');
    return !!annotationTarget && annotationTarget.dataset.annotationId === String(annotationId);
  }

  function getAnnotationIdFromChromeTarget(node) {
    const element = toEventElement(node);
    if (!element || !element.closest) {
      return null;
    }

    const annotationTarget = element.closest('.ca-marker[data-annotation-id], .ca-rect[data-annotation-id], .ca-hover[data-annotation-id]');
    if (!annotationTarget) {
      return null;
    }

    const annotationId = Number(annotationTarget.dataset.annotationId);
    return Number.isFinite(annotationId) ? annotationId : null;
  }

  function toEventElement(node) {
    if (!node) {
      return null;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      return node;
    }

    return node.parentElement || null;
  }

  function createCssPath(element) {
    const path = [];
    let current = element;
    while (
      current
      && current.nodeType === Node.ELEMENT_NODE
      && current.tagName.toLowerCase() !== 'html'
      && current.tagName.toLowerCase() !== 'body'
    ) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector += `#${cssEscape(current.id)}`;
        path.unshift(selector);
        break;
      }

      const classNames = Array.from(current.classList).slice(0, 2).map((name) => `.${cssEscape(name)}`).join('');
      if (classNames) {
        selector += classNames;
      }

      if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }

      path.unshift(selector);
      current = current.parentElement;
    }
    if (path[0] !== 'body') {
      path.unshift('body');
    }
    return path.join(' > ');
  }

  function describeElement(element) {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    const className = element.classList.length > 0 ? `.${Array.from(element.classList).slice(0, 2).join('.')}` : '';
    const text = truncate(getVisibleText(element), 30);
    if (tag === 'a' && element.href) {
      return `link to ${element.href}`;
    }
    if (text) {
      return `${tag}${id}${className} "${text}"`;
    }
    return `${tag}${id}${className}`;
  }

  function getVisibleText(element) {
    return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function formatStyles(styles) {
    return Object.entries(styles)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
  }

  function dedupeElements(elements) {
    const seen = new Set();
    return elements.reduce((accumulator, element) => {
      const snapshot = createElementSnapshot(element);
      if (!seen.has(snapshot.selector)) {
        seen.add(snapshot.selector);
        accumulator.push(snapshot);
      }
      return accumulator;
    }, []);
  }

  function intersects(a, b) {
    return a.x < b.x + b.width
      && a.x + a.width > b.x
      && a.y < b.y + b.height
      && a.y + a.height > b.y;
  }

  function toolLabelForType(type) {
    if (type === 'text') {
      return 'Text Selection';
    }
    if (type === 'element') {
      return 'Element Selection';
    }
    if (type === 'multi') {
      return 'Multi-Select';
    }
    return 'Area Selection';
  }

  function truncate(value, maxLength) {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength - 3)}...`;
  }

  function postToHost(type, payload) {
    const message = {
      source: 'copilot-annotation-runtime',
      type,
      ...payload
    };

    const api = getVsCodeApi();
    if (api) {
      api.postMessage(message);
      return;
    }

    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, '*');
    }
  }

  function getVsCodeApi() {
    if (!vscodeApi && typeof acquireVsCodeApi === 'function') {
      vscodeApi = acquireVsCodeApi();
    }

    return vscodeApi;
  }

  function getScrollContainer() {
    return document.body;
  }

  function getScrollOffsets() {
    const scrollContainer = getScrollContainer();
    return {
      left: scrollContainer.scrollLeft,
      top: scrollContainer.scrollTop
    };
  }

  function getScrollViewportRect() {
    const rect = getScrollContainer().getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
  }

  function viewportRectToPageRect(rect) {
    const scroll = getScrollOffsets();
    const viewport = getScrollViewportRect();
    return {
      x: rect.left - viewport.left + scroll.left,
      y: rect.top - viewport.top + scroll.top,
      width: rect.width,
      height: rect.height
    };
  }

  function pageRectToViewportRect(rect) {
    const viewportPoint = pagePointToViewportPoint(rect.x, rect.y);
    return {
      x: viewportPoint.x,
      y: viewportPoint.y,
      width: rect.width,
      height: rect.height
    };
  }

  function pagePointToViewportPoint(pageX, pageY) {
    const scroll = getScrollOffsets();
    const viewport = getScrollViewportRect();
    return {
      x: pageX - scroll.left + viewport.left,
      y: pageY - scroll.top + viewport.top
    };
  }

  function toPagePoint(clientX, clientY) {
    const scroll = getScrollOffsets();
    const viewport = getScrollViewportRect();
    return {
      x: clientX - viewport.left + scroll.left,
      y: clientY - viewport.top + scroll.top
    };
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
})();