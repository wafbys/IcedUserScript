// ==UserScript==
// @name         CJK/Mono 字体替换
// @namespace    http://tampermonkey.net/
// @version      3.10.9
// @description  高性能汉字/假名及等宽字体替换。支持按网站配置、Shadow DOM、动态内容及输入框实时替换。附带热键控制面板 (Ctrl+Shift+F)。
// @match        *://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @downloadURL  https://raw.githubusercontent.com/wafbys/cjk-mono-userscript/master/cjk-mono.user.js
// @updateURL    https://raw.githubusercontent.com/wafbys/cjk-mono-userscript/master/cjk-mono.user.js
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'CJK_MONO_FONT_CONFIG';
  const PATCH_ATTR = 'data-cjk-patched';
  const ORIG_ATTR = 'data-cjk-orig-font';
  const BATCH_SIZE = 400;
  const IDLE_TIMEOUT_MS = 150;
  const CURRENT_HOST = location.hostname;
  const CJK_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);

  // 仅这些站点注入 CSS 变量 / 正文选择器；其它站点只走 @font-face + DOM 补丁
  const READING_SITE_SUFFIXES = ['dutongjian.com'];

  const CSS_FONT_VARS = [
    '--font-family-classical',
    '--font-family-modern',
    '--font-family-translation',
    '--font-family-ui',
    '--font-family-guben-excerpt-fixed',
  ];

  const READING_CONTENT_SELECTORS = [
    '.original-text',
    '.paragraph-classical',
    '.paragraph-modern',
    '.paragraph.translation',
    '.section-text',
    '.section-text--classical',
    '.section-text--note',
    '.guben-book-excerpt-card__surface',
    '[class*="paragraph-content"]',
    '[class*="reader-content"]',
  ].join(',\n      ');

  function extraHostCss() {
    if (!hostEqualsOrSuffix(CURRENT_HOST, 'tieba.baidu.com')) return '';
    // 新版贴吧 CSR：index.css 有 `*{font-family:PingFang SC,...}`，每个节点自己带字体
    return `
      #app {
        --cos-font-family: "CJKPatch", "PingFang SC";
        --text-family-chinese: "CJKPatch", "PingFang SC";
      }
      #app, #app *:not(code):not(pre):not(kbd):not(samp) {
        font-family: "CJKPatch", "PingFang SC", Arial, sans-serif, tahoma !important;
      }
      #app .baidunumber-Bold,
      #app .baidunumber-Medium,
      #app .baidunumber-Regular,
      #app .cos-font-family-number {
        font-family: "CJKPatch", baidunumber-Regular, baidunumber-Medium, baidunumber-Bold, "baidunumber plus" !important;
      }`;
  }

  const DEFAULT_CONFIG = {
    enabled: true,
    siteBlacklist: [],
    fonts: {
      default: {
        cjk: 'KingHwaOldSong-GB',
        code: 'NewComputerModern Mono 10',
      },
      sites: {}
    },
    // 覆盖汉字基本区 + 扩展 A–J、假名、兼容汉字、全角等，避免生僻字不走 CJKPatch
    unicodeRange: [
      'U+2E80-2EFF', 'U+2F00-2FDF', 'U+3000-303F', 'U+3040-309F', 'U+30A0-30FF',
      'U+3100-312F', 'U+31A0-31BF', 'U+31C0-31EF', 'U+31F0-31FF',
      'U+3200-32FF', 'U+3300-33FF', 'U+3400-4DBF', 'U+4E00-9FFF',
      'U+F900-FAFF', 'U+FE10-FE1F', 'U+FE30-FE4F', 'U+FF00-FFEF',
      'U+20000-2A6DF', 'U+2A700-2B73F', 'U+2B740-2B81F', 'U+2B820-2CEAF',
      'U+2CEB0-2EBEF', 'U+2EBF0-2EE5F', 'U+2F800-2FA1F',
      'U+30000-3134F', 'U+31350-323AF', 'U+323B0-3347F',
    ].join(', '),
  };

  const FONT_CHOICES = {
    cjk: ['KingHwaOldSong-GB', 'Ku Mincho', 'Ku Mincho BIG5GB'],
    code: ['NewComputerModern Mono 10', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Courier New'],
  };

  function hostEqualsOrSuffix(host, suffix) {
    return host === suffix || host.endsWith('.' + suffix);
  }

  function isReadingSite(host = CURRENT_HOST) {
    return READING_SITE_SUFFIXES.some(suffix => hostEqualsOrSuffix(host, suffix));
  }

  function isGrokHost(host = CURRENT_HOST) {
    return hostEqualsOrSuffix(host, 'grok.com');
  }

  function buildLocalSrc(fontName) {
    return `local("${fontName}")`;
  }

  const CONFIG = {};
  const pendingNodesMap = new WeakMap();
  const idleCallbackMap = new WeakMap();
  const observerMap = new WeakMap();
  const origCssVarMap = new WeakMap();

  let sentinelId = null;
  let grokProtectorId = null;
  let allowCssVarMutations = false;
  let hooksReady = false;
  let patchStarted = false;
  const earlyShadows = [];

  function withNativeCssVars(fn) {
    allowCssVarMutations = true;
    try { return fn(); }
    finally { allowCssVarMutations = false; }
  }

  const ric = window.requestIdleCallback || function (cb) {
    return setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), 1);
  };
  const cancelRic = window.cancelIdleCallback || clearTimeout;

  async function loadConfig() {
    const saved = await GM_getValue(STORAGE_KEY, {});

    if (saved.font && !saved.fonts) {
      saved.fonts = { sites: {} };
    }

    Object.assign(CONFIG, DEFAULT_CONFIG, {
      enabled: saved.enabled !== undefined ? saved.enabled : DEFAULT_CONFIG.enabled,
      siteBlacklist: saved.siteBlacklist || [],
      fonts: {
        default: { ...DEFAULT_CONFIG.fonts.default },
        sites: saved.fonts?.sites || {}
      }
    });

    const siteConfig = CONFIG.fonts.sites[CURRENT_HOST] || {};
    CONFIG.font = { ...CONFIG.fonts.default, ...siteConfig };
  }

  async function saveConfig() {
    const toSave = {
      enabled: CONFIG.enabled,
      siteBlacklist: CONFIG.siteBlacklist,
      fonts: {
        sites: CONFIG.fonts.sites || {}
      }
    };
    await GM_setValue(STORAGE_KEY, toSave);
  }

  function persistSiteFont(partial) {
    CONFIG.font = { ...CONFIG.fonts.default, ...CONFIG.font, ...partial };
    CONFIG.fonts.sites[CURRENT_HOST] = { cjk: CONFIG.font.cjk, code: CONFIG.font.code };
  }

  const isSiteBlacklisted = () => CONFIG.siteBlacklist.some(domain => {
    if (domain === CURRENT_HOST) return true;
    if (domain.startsWith('*.')) {
      const suffix = domain.slice(2);
      return CURRENT_HOST === suffix || CURRENT_HOST.endsWith('.' + suffix);
    }
    return false;
  });

  const isPatchActive = () => CONFIG.enabled && !isSiteBlacklisted();

  function stripCjkPatchPrefix(value) {
    let s = String(value || '').trim();
    while (/^"CJKPatch"\s*,\s*/.test(s)) {
      s = s.replace(/^"CJKPatch"\s*,\s*/, '').trim();
    }
    return s;
  }

  function rememberOrigCssVars(doc) {
    if (!isReadingSite()) return;
    const root = doc?.documentElement;
    if (!root) return;
    const saved = origCssVarMap.get(root) || {};
    for (const name of CSS_FONT_VARS) {
      if (saved[name]?.computed) continue;
      let computed = '';
      try { computed = getComputedStyle(root).getPropertyValue(name).trim(); } catch (e) {}
      const inline = root.style.getPropertyValue(name);
      const stripped = stripCjkPatchPrefix(computed || inline);
      if (!stripped) continue;
      saved[name] = {
        inline,
        priority: root.style.getPropertyPriority(name),
        computed: stripped,
      };
    }
    origCssVarMap.set(root, saved);
  }

  function patchedVarValue(name, root) {
    let current = '';
    try { current = getComputedStyle(root).getPropertyValue(name).trim(); } catch (e) {}
    const captured = origCssVarMap.get(root)?.[name]?.computed || '';
    const base = stripCjkPatchPrefix(current && !current.includes('CJKPatch') ? current : (current || captured));
    return base ? `"CJKPatch", ${base}` : '';
  }

  function injectGlobalStyle(doc = document) {
    if (!doc || doc.nodeType === 11 || !doc.head) return;
    const parent = doc.head;
    const oldStyle = (doc.getElementById && doc.getElementById('cjk-mono-patch-style'))
      || parent.querySelector?.('#cjk-mono-patch-style');
    if (oldStyle) oldStyle.remove();
    if (!isPatchActive()) return;

    const cjkName = CONFIG.font?.cjk || DEFAULT_CONFIG.fonts.default.cjk;
    const codeName = CONFIG.font?.code || DEFAULT_CONFIG.fonts.default.code;
    const localSrc = buildLocalSrc(cjkName);

    let readingCss = '';
    if (isReadingSite()) {
      rememberOrigCssVars(doc);
      const root = doc.documentElement;
      const varLines = [];
      if (root) {
        for (const name of CSS_FONT_VARS) {
          const value = patchedVarValue(name, root);
          if (value) varLines.push(`${name}: ${value} !important;`);
        }
      }
      if (varLines.length) {
        readingCss += `
      :root, html, :host {
        ${varLines.join('\n        ')}
      }`;
      }
      readingCss += `
      ${READING_CONTENT_SELECTORS} {
        font-family: "CJKPatch", inherit !important;
      }`;
    }

    const css = `
      @font-face {
        font-family: "CJKPatch";
        src: ${localSrc};
        unicode-range: ${DEFAULT_CONFIG.unicodeRange};
        font-display: swap;
      }${readingCss}${extraHostCss()}
      code, pre, kbd, samp {
        font-family: "${codeName}", "Cascadia Code", "JetBrains Mono", "Fira Code", "Consolas", "${cjkName}", monospace !important;
        font-variant-ligatures: none;
      }
    `;
    const style = doc.createElement('style');
    style.id = 'cjk-mono-patch-style';
    style.textContent = css;
    parent.appendChild(style);

    if (isReadingSite()) {
      withNativeCssVars(() => {
        try {
          const root = doc.documentElement;
          if (root?.style) {
            let patched = 0;
            for (const name of CSS_FONT_VARS) {
              const value = patchedVarValue(name, root);
              if (!value) continue;
              root.style.setProperty(name, value, 'important');
              patched += 1;
            }
            if (patched) root.setAttribute('data-cjk-vars-patched', '1');
          }
        } catch (e) {}
      });
    }
  }

  function clearCssVarOverrides(doc = document) {
    withNativeCssVars(() => {
      try {
        const root = doc?.documentElement;
        if (!root?.style || root.getAttribute('data-cjk-vars-patched') !== '1') return;
        const saved = origCssVarMap.get(root) || {};
        for (const name of CSS_FONT_VARS) {
          const rec = saved[name];
          if (rec?.inline) {
            root.style.setProperty(name, rec.inline, rec.priority || undefined);
          } else {
            root.style.removeProperty(name);
          }
        }
        origCssVarMap.delete(root);
        root.removeAttribute('data-cjk-vars-patched');
      } catch (e) {}
    });
  }

  function collectTextNodes(rootNode) {
    if (!rootNode || !isPatchActive()) return;

    const doc = rootNode.ownerDocument || rootNode;
    if (!pendingNodesMap.has(doc)) pendingNodesMap.set(doc, []);
    const pendingTextNodes = pendingNodesMap.get(doc);

    const effectiveRoot = (rootNode.nodeType === 1 || rootNode.nodeType === 11) ? rootNode : doc.body;
    if (!effectiveRoot) return;

    const walker = doc.createTreeWalker(effectiveRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return (node.nodeValue && CJK_REGEX.test(node.nodeValue)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      pendingTextNodes.push(node);
    }

    const elementWalker = doc.createTreeWalker(effectiveRoot, NodeFilter.SHOW_ELEMENT);
    while ((node = elementWalker.nextNode())) {
      if (node.shadowRoot) collectTextNodes(node.shadowRoot);
    }

    if (effectiveRoot.querySelectorAll) {
      effectiveRoot.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(el => {
        const text = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
          ? (el.value || el.placeholder || '')
          : (el.textContent || '');
        if (CJK_REGEX.test(text)) applyPatchToElement(el);
      });
    }

    scheduleProcessing(doc);
  }

  function scheduleProcessing(doc) {
    if (idleCallbackMap.get(doc) != null) return;
    const handle = ric(() => processPendingNodes(doc), { timeout: IDLE_TIMEOUT_MS });
    idleCallbackMap.set(doc, handle);
  }

  function findPatchableElement(textNode) {
    const el = textNode.parentElement;
    if (!el || SKIP_TAGS.has(el.tagName)) return null;
    // 贴在文字的直接父节点。a/span 等包装标签即使计算值和父级相同，
    // 也常自己写了同名 font-family，补丁打在祖先压不住（贴吧标题即如此）。
    return el;
  }

  function applyPatchToElement(el) {
    if (!el || el.nodeType !== 1 || !isPatchActive()) return;
    try {
      const computedFamily = getComputedStyle(el).fontFamily;
      const inlineFamily = el.style.fontFamily || '';
      if (computedFamily.includes('CJKPatch') || inlineFamily.includes('CJKPatch')) {
        if (!el.hasAttribute(PATCH_ATTR)) el.setAttribute(PATCH_ATTR, 'computed');
        return;
      }
      if (!el.hasAttribute(ORIG_ATTR)) {
        el.setAttribute(ORIG_ATTR, inlineFamily);
      }
      el.style.setProperty('font-family', `"CJKPatch", ${computedFamily}`, 'important');
      el.setAttribute(PATCH_ATTR, 'inlined');
    } catch (e) {}
  }

  function processPendingNodes(doc) {
    idleCallbackMap.set(doc, null);
    if (!isPatchActive()) {
      pendingNodesMap.delete(doc);
      return;
    }
    const pendingTextNodes = pendingNodesMap.get(doc);
    if (!pendingTextNodes || pendingTextNodes.length === 0) return;
    const batch = pendingTextNodes.splice(0, BATCH_SIZE);
    for (const node of batch) {
      if (!node?.parentElement) continue;
      const el = findPatchableElement(node);
      if (el) applyPatchToElement(el);
    }
    if (pendingTextNodes.length > 0) scheduleProcessing(doc);
  }

  function observeMutations(rootNode) {
    if (observerMap.has(rootNode)) observerMap.get(rootNode).disconnect();
    if (!isPatchActive()) return;

    const target = rootNode.body || (rootNode.nodeType === 11 ? rootNode : null);
    if (!target) return;

    const observer = new MutationObserver((mutations) => {
      if (!isPatchActive()) return;
      for (const m of mutations) {
        if (m.type === 'characterData') {
          const textNode = m.target;
          if (textNode.nodeType === 3 && CJK_REGEX.test(textNode.nodeValue)) {
            const el = findPatchableElement(textNode);
            if (el) applyPatchToElement(el);
          }
          continue;
        }
        for (const n of m.addedNodes) {
          if (n.nodeType === 3) {
            if (CJK_REGEX.test(n.nodeValue || '')) {
              const el = findPatchableElement(n);
              if (el) applyPatchToElement(el);
            }
            continue;
          }
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'IFRAME') {
            processIframe(n);
          } else if (n.querySelectorAll) {
            n.querySelectorAll('iframe').forEach(processIframe);
          }
          collectTextNodes(n);
        }
      }
    });

    observer.observe(target, { childList: true, subtree: true, characterData: true });
    observerMap.set(rootNode, observer);
  }

  function processIframe(iframe) {
    try {
      const doc = iframe.contentDocument;
      if (doc && (doc.readyState === 'complete' || doc.readyState === 'interactive')) {
        runOnDocument(doc);
      } else {
        iframe.addEventListener('load', () => processIframe(iframe), { once: true });
      }
    } catch (e) {}
  }

  try {
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const shadowRoot = originalAttachShadow.call(this, options);
      try {
        if (!hooksReady) earlyShadows.push(shadowRoot);
        else if (isPatchActive()) runOnDocument(shadowRoot);
      } catch (e) {}
      return shadowRoot;
    };
  } catch (e) {}

  function flushEarlyShadows() {
    hooksReady = true;
    const pending = earlyShadows.splice(0, earlyShadows.length);
    if (!isPatchActive()) return;
    for (const sr of pending) runOnDocument(sr);
  }

  function stopSentinelPolling() {
    if (sentinelId != null) {
      clearInterval(sentinelId);
      sentinelId = null;
    }
  }

  function startSentinelPolling() {
    stopSentinelPolling();
    if (!isPatchActive()) return;
    const interval = 800;
    const duration = 60000;
    let elapsed = 0;
    sentinelId = setInterval(() => {
      if (!isPatchActive() || elapsed >= duration) {
        stopSentinelPolling();
        return;
      }
      const root = document.documentElement;
      const styleMissing = !document.getElementById('cjk-mono-patch-style');
      let needsInject = styleMissing;
      if (isReadingSite()) {
        const classical = root ? getComputedStyle(root).getPropertyValue('--font-family-classical').trim() : '';
        const varsStolen = classical && !classical.includes('CJKPatch');
        const varsPending = classical && root.getAttribute('data-cjk-vars-patched') !== '1';
        needsInject = needsInject || varsStolen || varsPending;
      }
      if (needsInject) injectGlobalStyle(document);
      document.querySelectorAll('iframe').forEach(processIframe);
      elapsed += interval;
    }, interval);
  }

  let cssVarAttrObserver = null;

  function stopCssVarAttrObserver() {
    if (cssVarAttrObserver) {
      cssVarAttrObserver.disconnect();
      cssVarAttrObserver = null;
    }
  }

  function startCssVarAttrObserver() {
    stopCssVarAttrObserver();
    if (!isPatchActive() || !isReadingSite()) return;
    const root = document.documentElement;
    if (!root) return;
    cssVarAttrObserver = new MutationObserver(() => {
      if (allowCssVarMutations || !isPatchActive() || !isReadingSite()) return;
      let classical = '';
      try { classical = getComputedStyle(root).getPropertyValue('--font-family-classical').trim(); } catch (e) {}
      if (classical && !classical.includes('CJKPatch')) injectGlobalStyle(document);
    });
    cssVarAttrObserver.observe(root, { attributes: true, attributeFilter: ['style'] });
  }

  function installCssVarGuard() {
    if (installCssVarGuard._done) return;
    installCssVarGuard._done = true;
    try {
      const proto = CSSStyleDeclaration.prototype;
      const original = proto.setProperty;
      proto.setProperty = function (prop, value, priority) {
        if (
          !allowCssVarMutations
          && isPatchActive()
          && isReadingSite()
          && typeof prop === 'string'
          && CSS_FONT_VARS.includes(prop)
          && typeof value === 'string'
          && !value.includes('CJKPatch')
        ) {
          try {
            if (this === document.documentElement.style) {
              return original.call(this, prop, `"CJKPatch", ${value}`, 'important');
            }
          } catch (e) {}
        }
        return original.apply(this, arguments);
      };
    } catch (e) {}
  }

  function installHistoryHooks() {
    if (installHistoryHooks._done) return;
    installHistoryHooks._done = true;
    try {
      const rescanOnNav = () => {
        if (!isPatchActive()) return;
        setTimeout(() => {
          injectGlobalStyle(document);
          collectTextNodes(document.body);
        }, 50);
      };
      window.addEventListener('popstate', rescanOnNav);
      const _push = history.pushState;
      const _replace = history.replaceState;
      history.pushState = function () {
        const r = _push.apply(this, arguments);
        rescanOnNav();
        return r;
      };
      history.replaceState = function () {
        const r = _replace.apply(this, arguments);
        rescanOnNav();
        return r;
      };
    } catch (e) {}
  }

  function stopGrokProtector() {
    if (grokProtectorId != null) {
      clearInterval(grokProtectorId);
      grokProtectorId = null;
    }
  }

  function startGrokProtector() {
    stopGrokProtector();
    if (!isPatchActive() || !isGrokHost()) return;
    grokProtectorId = setInterval(() => {
      if (!isPatchActive()) {
        stopGrokProtector();
        return;
      }
      document.querySelectorAll(
        '.message-bubble, [data-testid="assistant-message"], [data-testid="user-message"], .response-content-markdown, .prose'
      ).forEach(el => {
        if (el.textContent && CJK_REGEX.test(el.textContent)) applyPatchToElement(el);
      });
    }, 1000);
  }

  function startRuntimeHooks() {
    installHistoryHooks();
    startCssVarAttrObserver();
    startSentinelPolling();
    startGrokProtector();
  }

  function stopRuntimeHooks() {
    stopCssVarAttrObserver();
    stopSentinelPolling();
    stopGrokProtector();
  }

  function bindInputEvents(doc) {
    if (doc.__cjkInputBound) return;
    doc.__cjkInputBound = true;
    doc.addEventListener('input', (e) => {
      if (!isPatchActive()) return;
      const el = e.target;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(el.tagName))) {
        if (CJK_REGEX.test(el.value || el.textContent)) applyPatchToElement(el);
      }
    });
  }

  function forEachOpenShadowRoot(root, visit) {
    const doc = root.ownerDocument || root;
    const start = root.body || root;
    if (!start) return;
    const consider = (el) => {
      if (!el?.shadowRoot) return;
      visit(el.shadowRoot);
      forEachOpenShadowRoot(el.shadowRoot, visit);
    };
    if (start.nodeType === 1) consider(start);
    const walker = doc.createTreeWalker(start, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) consider(el);
  }

  function undoPatchesInRoot(root) {
    if (!root) return;
    observerMap.get(root)?.disconnect();
    observerMap.delete(root);
    if (idleCallbackMap.has(root)) {
      cancelRic(idleCallbackMap.get(root));
      idleCallbackMap.set(root, null);
    }
    pendingNodesMap.delete(root);

    const styleEl = root.getElementById
      ? root.getElementById('cjk-mono-patch-style')
      : root.querySelector?.('#cjk-mono-patch-style');
    styleEl?.remove();

    if (root.querySelectorAll) {
      root.querySelectorAll(`[${PATCH_ATTR}]`).forEach(el => {
        try {
          el.style.fontFamily = el.getAttribute(ORIG_ATTR) || '';
          el.removeAttribute(PATCH_ATTR);
          el.removeAttribute(ORIG_ATTR);
        } catch (e) {}
      });
    }
  }

  function undoAllPatches(doc = document) {
    if (!doc) return;
    undoPatchesInRoot(doc);
    clearCssVarOverrides(doc);
    forEachOpenShadowRoot(doc, undoPatchesInRoot);

    if (doc.querySelectorAll) {
      doc.querySelectorAll('iframe').forEach(iframe => {
        try { undoAllPatches(iframe.contentDocument); } catch (e) {}
      });
    }
  }

  function runOnDocument(doc) {
    if (!isPatchActive() || !doc) return;
    injectGlobalStyle(doc);
    const root = doc.body || (doc.nodeType === 11 ? doc : null);
    if (!root) return;
    collectTextNodes(root);
    observeMutations(doc);
    bindInputEvents(doc);
  }

  function fullRescan() {
    undoAllPatches(document);
    patchStarted = false;
    if (isPatchActive()) {
      patchStarted = true;
      hooksReady = true;
      runOnDocument(document);
      document.querySelectorAll('iframe').forEach(processIframe);
      startRuntimeHooks();
    } else {
      hooksReady = true;
      stopRuntimeHooks();
    }
  }

  function startPatching() {
    let bootObs = null;
    let styleInjected = false;

    const tryInjectStyle = () => {
      if (styleInjected || !document.head) return;
      injectGlobalStyle(document);
      styleInjected = true;
    };

    const tryStartDom = () => {
      if (!document.body || patchStarted) return;
      patchStarted = true;
      bootObs?.disconnect();
      ric(() => {
        flushEarlyShadows();
        if (!isPatchActive()) return;
        runOnDocument(document);
        document.querySelectorAll('iframe').forEach(processIframe);
        startRuntimeHooks();
      }, { timeout: IDLE_TIMEOUT_MS });
    };

    tryInjectStyle();
    tryStartDom();
    if (patchStarted) return;

    bootObs = new MutationObserver(() => {
      tryInjectStyle();
      tryStartDom();
    });
    bootObs.observe(document.documentElement || document, { childList: true });
  }

  let controlPanel = null;

  function createControlPanel() {
    if (document.getElementById('cjk-mono-panel')) return;

    controlPanel = document.createElement('div');
    controlPanel.id = 'cjk-mono-panel';
    controlPanel.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; background: rgba(30,30,30,0.95); color: #f0f0f0;
      font-family: system-ui, sans-serif; font-size: 14px; padding: 15px; border-radius: 10px;
      z-index: 2147483647; line-height: 1.8; width: 300px; box-shadow: 0 8px 25px rgba(0,0,0,0.5);
      border: 1px solid rgba(255,255,255,0.15); backdrop-filter: blur(10px); display: none;
    `;

    controlPanel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <b style="font-size:16px;">CJK/Mono 字体面板</b>
        <span id="cjkPanelClose" style="cursor:pointer;font-weight:bold;font-size:20px;">×</span>
      </div>
      <div style="margin-bottom:8px;font-size:13px;color:#aaa;">当前站点：<strong>${CURRENT_HOST}</strong></div>
      <label style="display:flex;align-items:center;cursor:pointer;">
        <input type="checkbox" id="cjkToggle"> 启用脚本
      </label>
      <hr style="border:0;border-top:1px solid #555;margin:10px 0;">
      <div>正文 CJK 字体:</div>
      <select id="cjkFontSelect" style="width:100%;background:#333;color:#fff;border:1px solid #555;border-radius:4px;padding:4px;"></select>
      <div style="margin-top:8px;">代码字体:</div>
      <select id="codeFontSelect" style="width:100%;background:#333;color:#fff;border:1px solid #555;border-radius:4px;padding:4px;"></select>
      <div style="margin-top:10px;">
        <button id="resetToGlobal" style="width:100%;padding:6px 12px;background:#444;color:#fff;border:1px solid #666;border-radius:4px;cursor:pointer;">重置为全局默认</button>
      </div>
      <hr style="border:0;border-top:1px solid #555;margin:12px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <b>站点黑名单</b>
        <button id="blacklistAddCurrent" style="font-size:11px;padding:3px 8px;background:#444;color:#fff;border:1px solid #666;border-radius:4px;cursor:pointer;">+ 添加当前</button>
      </div>
      <div id="blacklistContainer" style="margin-top:8px;max-height:80px;overflow-y:auto;font-size:12px;"></div>
      <div style="margin-top:12px;text-align:right;">
        <button id="debugStorageBtn" style="font-size:11px;padding:2px 8px;background:#333;color:#aaa;border:1px solid #555;border-radius:3px;cursor:pointer;">调试存储</button>
      </div>
    `;

    document.body.appendChild(controlPanel);

    const cjkSelect = controlPanel.querySelector('#cjkFontSelect');
    const codeSelect = controlPanel.querySelector('#codeFontSelect');
    FONT_CHOICES.cjk.forEach(f => cjkSelect.add(new Option(f, f)));
    FONT_CHOICES.code.forEach(f => codeSelect.add(new Option(f, f)));

    const ui = {
      toggle: controlPanel.querySelector('#cjkToggle'),
      cjkSelect,
      codeSelect,
      resetBtn: controlPanel.querySelector('#resetToGlobal'),
      blContainer: controlPanel.querySelector('#blacklistContainer'),
      addBtn: controlPanel.querySelector('#blacklistAddCurrent'),
      closeBtn: controlPanel.querySelector('#cjkPanelClose'),
      debugBtn: controlPanel.querySelector('#debugStorageBtn'),
    };

    function ensureSelectValue(select, value) {
      select.value = value;
      if (select.value !== value) select.selectedIndex = 0;
    }

    ui.toggle.checked = CONFIG.enabled;
    ensureSelectValue(ui.cjkSelect, CONFIG.font.cjk);
    ensureSelectValue(ui.codeSelect, CONFIG.font.code);

    ui.toggle.addEventListener('change', async () => {
      CONFIG.enabled = ui.toggle.checked;
      await saveConfig();
      fullRescan();
    });

    ui.cjkSelect.addEventListener('change', async () => {
      persistSiteFont({ cjk: ui.cjkSelect.value });
      await saveConfig();
      fullRescan();
    });

    ui.codeSelect.addEventListener('change', async () => {
      persistSiteFont({ code: ui.codeSelect.value });
      await saveConfig();
      fullRescan();
    });

    ui.resetBtn.addEventListener('click', async () => {
      delete CONFIG.fonts.sites[CURRENT_HOST];
      CONFIG.font = { ...CONFIG.fonts.default };
      await saveConfig();
      ensureSelectValue(ui.cjkSelect, CONFIG.font.cjk);
      ensureSelectValue(ui.codeSelect, CONFIG.font.code);
      fullRescan();
    });

    ui.closeBtn.addEventListener('click', () => {
      controlPanel.style.display = 'none';
    });

    ui.addBtn.addEventListener('click', async () => {
      if (!CONFIG.siteBlacklist.includes(CURRENT_HOST)) {
        CONFIG.siteBlacklist.push(CURRENT_HOST);
        await saveConfig();
        renderDomainList();
        fullRescan();
      }
    });

    ui.debugBtn.addEventListener('click', async () => {
      const saved = await GM_getValue(STORAGE_KEY, {});
      console.log('[CJK Font] Storage:', saved);
      console.log('[CJK Font] Current CONFIG.fonts.default:', CONFIG.fonts.default);
    });

    function renderDomainList() {
      ui.blContainer.innerHTML = '';
      if (CONFIG.siteBlacklist.length === 0) {
        ui.blContainer.innerHTML = '<span style="color:#888;">无</span>';
        return;
      }
      CONFIG.siteBlacklist.forEach(domain => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:2px 0;';
        item.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${domain}</span>
          <button style="font-size:10px;padding:1px 6px;background:#500;color:#fff;border:1px solid #800;border-radius:3px;cursor:pointer;">移除</button>`;
        item.querySelector('button').addEventListener('click', async () => {
          CONFIG.siteBlacklist = CONFIG.siteBlacklist.filter(d => d !== domain);
          await saveConfig();
          renderDomainList();
          fullRescan();
        });
        ui.blContainer.appendChild(item);
      });
    }

    renderDomainList();
  }

  function togglePanel() {
    if (!document.body) return;
    if (!controlPanel) createControlPanel();
    controlPanel.style.display = (controlPanel.style.display === 'none' || !controlPanel.style.display) ? 'block' : 'none';
  }

  function setupHotkey() {
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') {
        e.preventDefault();
        e.stopImmediatePropagation();
        togglePanel();
      }
    }, true);
  }

  async function main() {
    await loadConfig();
    installCssVarGuard();
    setupHotkey();
    if (isPatchActive()) startPatching();
    else flushEarlyShadows();
  }

  main().catch(console.error);
})();
