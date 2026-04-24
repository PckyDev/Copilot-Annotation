// @ts-nocheck

  function render(preserveMarkers = false) {
    preserveMarkers = preserveMarkers === true;

    if (!layer) {
      return;
    }

    refreshTransientGeometries();
    refreshAnnotationGeometries();

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
    if (toolbar) {
      toolbar.querySelectorAll('[data-tool]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.tool === state.tool));
      });
    }
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

