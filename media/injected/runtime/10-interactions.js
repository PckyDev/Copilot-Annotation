// @ts-nocheck

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
        state.hoverSelector = null;
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
      state.hoverSelector = element ? createCssPath(element) : null;
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
    state.hoverSelector = null;
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
        anchorRects: draft.element.rects,
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

