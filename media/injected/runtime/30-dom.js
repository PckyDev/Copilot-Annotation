// @ts-nocheck

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
      rects: getDisplayRectsForElement(element),
      styles: captureStyles(element)
    };
  }

  function rectsFromElement(element) {
    return clientRectsToPageRects(element.getClientRects());
  }

  function getDisplayRectsForElement(element) {
    const ownRects = rectsFromElement(element);
    if (ownRects.length > 0) {
      return ownRects;
    }

    const contentRects = rectsFromElementContents(element);
    if (contentRects.length > 0) {
      return contentRects;
    }

    const descendantRects = getDescendantRects(element);
    if (descendantRects.length === 0) {
      return [];
    }

    return [combineRects(descendantRects)];
  }

  function rectsFromElementContents(element) {
    if (!element || !element.ownerDocument || typeof element.ownerDocument.createRange !== 'function') {
      return [];
    }

    const range = element.ownerDocument.createRange();
    try {
      range.selectNodeContents(element);
      return clientRectsToPageRects(range.getClientRects());
    } catch {
      return [];
    } finally {
      if (typeof range.detach === 'function') {
        range.detach();
      }
    }
  }

  function getDescendantRects(element) {
    if (!element || !element.querySelectorAll) {
      return [];
    }

    return Array.from(element.querySelectorAll('*')).flatMap((descendant) => {
      if (isAnnotationChrome(descendant)) {
        return [];
      }

      return rectsFromElement(descendant);
    });
  }

  function refreshAnnotationGeometries() {
    for (const annotation of state.annotations) {
      refreshAnnotationGeometry(annotation);
    }
  }

  function refreshTransientGeometries() {
    if (state.hoverSelector && (state.tool === 'element' || state.tool === 'multi')) {
      const hoveredElement = queryElementBySelector(state.hoverSelector);
      state.hoverRect = hoveredElement ? firstRectForElement(hoveredElement) : null;
      if (!hoveredElement) {
        state.hoverSelector = null;
      }
    }

    if (state.multiDraft.length > 0) {
      state.multiDraft = state.multiDraft
        .map((entry) => refreshSnapshotFromSelector(entry))
        .filter((entry) => Boolean(entry));
    }
  }

  function refreshAnnotationGeometry(annotation) {
    const liveRects = getLiveAnnotationRects(annotation);
    if (Array.isArray(liveRects) && liveRects.length > 0) {
      annotation.rects = liveRects;
    }
  }

  function getLiveAnnotationRects(annotation) {
    if (!annotation || annotation.kind === 'area') {
      return annotation ? annotation.rects : [];
    }

    if (annotation.kind === 'multi') {
      const liveElements = Array.isArray(annotation.elements)
        ? annotation.elements
          .map((element) => refreshSnapshotFromSelector(element))
          .filter((element) => Boolean(element))
        : [];

      if (liveElements.length > 0) {
        annotation.elements = liveElements;
        return liveElements.flatMap((element) => element.rects);
      }

      return annotation.rects;
    }

    const liveElement = refreshSnapshotFromSelector({ selector: annotation.selector });
    if (!liveElement) {
      return annotation.rects;
    }

    annotation.selector = liveElement.selector;
    annotation.elementLabel = liveElement.label;

    if (annotation.kind === 'text') {
      const anchorRects = Array.isArray(annotation.anchorRects) && annotation.anchorRects.length > 0
        ? annotation.anchorRects
        : null;

      if (!anchorRects) {
        annotation.anchorRects = liveElement.rects;
        return annotation.rects;
      }

      const previousAnchorRect = combineRects(anchorRects);
      const nextAnchorRect = combineRects(liveElement.rects);
      annotation.anchorRects = liveElement.rects;
      return translateRects(annotation.rects, nextAnchorRect.x - previousAnchorRect.x, nextAnchorRect.y - previousAnchorRect.y);
    }

    return liveElement.rects;
  }

  function refreshSnapshotFromSelector(snapshot) {
    if (!snapshot || !snapshot.selector) {
      return null;
    }

    const element = queryElementBySelector(snapshot.selector);
    if (!element) {
      return null;
    }

    return createElementSnapshot(element);
  }

  function queryElementBySelector(selector) {
    try {
      const element = document.querySelector(selector);
      if (!element || isAnnotationChrome(element)) {
        return null;
      }

      return element;
    } catch {
      return null;
    }
  }

  function translateRects(rects, deltaX, deltaY) {
    return rects.map((rect) => ({
      x: rect.x + deltaX,
      y: rect.y + deltaY,
      width: rect.width,
      height: rect.height
    }));
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
    const rects = getDisplayRectsForElement(element);
    if (rects.length === 0) {
      return null;
    }

    return combineRects(rects);
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
    let stoppedAtStableId = false;
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
        stoppedAtStableId = true;
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

    if (!stoppedAtStableId && path[0] !== 'body') {
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
