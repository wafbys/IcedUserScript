// ==UserScript==
// @name         微信读书扫描 + 字体
// @namespace    https://weread.qq.com/
// @version      1.9
// @description  正文截图 + 可呼出的字体设置
// @author       Grok
// @match        https://weread.qq.com/web/reader/*
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const DB_NAME = 'weread_scan_db';
  const STORE_NAME = 'pages';
  const FONT_KEY = 'weread_font_settings';
  const PATCH_ATTR = 'data-weread-font-patched';
  const ORIG_ATTR = 'data-weread-orig-font';

  // 英文字体只按字符范围生效，不依赖站点是否给 sans/serif/mono 打标记
  const LATIN_RANGE = [
    'U+0000-00FF', 'U+0100-024F', 'U+0370-03FF', 'U+0400-04FF',
    'U+1E00-1EFF', 'U+1F00-1FFF',
    'U+2000-206F', 'U+20A0-20CF', 'U+2100-214F',
    'U+2190-21FF', 'U+2200-22FF', 'U+25A0-25FF',
  ].join(', ');

  const CJK_RANGE = [
    'U+2E80-2EFF', 'U+2F00-2FDF', 'U+3000-303F', 'U+3040-309F', 'U+30A0-30FF',
    'U+3100-312F', 'U+31A0-31BF', 'U+31C0-31EF', 'U+31F0-31FF',
    'U+3200-32FF', 'U+3300-33FF', 'U+3400-4DBF', 'U+4E00-9FFF',
    'U+F900-FAFF', 'U+FE10-FE1F', 'U+FE30-FE4F', 'U+FF00-FFEF',
    'U+20000-2A6DF', 'U+2A700-2B73F', 'U+2B740-2B81F', 'U+2B820-2CEAF',
    'U+2CEB0-2EBEF', 'U+2EBF0-2EE5F', 'U+2F800-2FA1F',
    'U+30000-3134F', 'U+31350-323AF', 'U+323B0-3347F',
  ].join(', ');

  const LATIN_FALLBACKS = {
    sans: ['Arial', 'Segoe UI', 'Helvetica'],
    serif: ['Times New Roman', 'Georgia'],
    mono: ['Consolas', 'Courier New'],
  };

  // local() 认的是字体内部名称，和面板里显示的名字不一定相同
  const LOCAL_FONT_ALIASES = {
    'Inter': ['Inter Variable Text', 'InterVariableText', 'Inter Variable'],
    'Stempel Garamond LT Std Subset': [
      'Stempel Garamond LT Std Subset Regular',
      'StempelGaramondLTStdSubset-Roman',
      'Stempel Garamond LT Std Subset',
    ],
    'NewComputerModern Mono 10': [
      'NewComputerModernMono10-Regular',
      'NewCMMono10-Regular',
      'NewComputerModern Mono 10',
    ],
    'Officina Serif ITC Pro': [
      'Officina Serif ITC Pro Book',
      'OfficinaSerifITCPro-Book',
      'Officina Serif ITC Pro',
    ],
    'KingHwaOldSong-GB': ['KingHwaOldSong-GB', 'KingHwaOldSongGB', '京華老宋体-GB印通表字形'],
    'Ku Mincho': ['Ku Mincho', 'KuMincho-Regular', 'Ku Mincho R', '空明朝體'],
  };

  const TEXT_REGEX = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const CODE_SELECTOR = 'code, pre, kbd, samp, .mono, [class*="mono"], [class*="code"]';
  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

  const fontOptions = {
    zh: ['KingHwaOldSong-GB', 'Ku Mincho'],
    sans: ['Inter'],
    serif: ['Stempel Garamond LT Std Subset', 'Valkyrie A', 'Officina Serif ITC Pro'],
    mono: ['NewComputerModern Mono 10']
  };

  const defaultFontSettings = {
    zh: { font: 'KingHwaOldSong-GB', enabled: true },
    sans: { font: 'Inter', enabled: true },
    serif: { font: 'Stempel Garamond LT Std Subset', enabled: true },
    mono: { font: 'NewComputerModern Mono 10', enabled: true },
    enMode: 'rules',   // 'book' | 'rules' | 'force'
    forceEn: 'serif'   // 仅 enMode === 'force' 时使用：'sans' | 'serif' | 'mono'
  };

  let db = null;
  let pages = [];
  let host = null;
  let shadow = null;
  let fontSettings = loadFontSettings();
  let fontPanelOpen = false;

  function loadFontSettings() {
    try {
      const raw = localStorage.getItem(FONT_KEY);
      if (!raw) return { ...defaultFontSettings };
      const saved = JSON.parse(raw);
      const merged = { ...defaultFontSettings, ...saved };
      for (const key of ['zh', 'sans', 'serif', 'mono']) {
        merged[key] = { ...defaultFontSettings[key], ...(saved[key] || {}) };
      }
      // 兼容旧配置：forceEn = '' / 'book' / 'sans' / 'serif' / 'mono'
      if (!['book', 'rules', 'force'].includes(merged.enMode)) {
        if (saved.forceEn === 'book') {
          merged.enMode = 'book';
        } else if (['sans', 'serif', 'mono'].includes(saved.forceEn)) {
          merged.enMode = 'force';
        } else {
          merged.enMode = 'rules';
        }
      }
      if (!['sans', 'serif', 'mono'].includes(merged.forceEn)) merged.forceEn = 'serif';
      return merged;
    } catch {
      return { ...defaultFontSettings };
    }
  }

  function saveFontSettings() {
    localStorage.setItem(FONT_KEY, JSON.stringify(fontSettings));
    applyFonts();
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      const timer = setTimeout(() => reject(new Error('IndexedDB 打开超时')), 10000);
      req.onupgradeneeded = e => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'index' });
        }
      };
      req.onsuccess = e => {
        clearTimeout(timer);
        resolve(e.target.result);
      };
      req.onerror = e => {
        clearTimeout(timer);
        reject(e.target.error || new Error('IndexedDB 打开失败'));
      };
      req.onblocked = () => {
        clearTimeout(timer);
        reject(new Error('IndexedDB 被其它标签页占用'));
      };
    });
  }

  function waitTransaction(tx, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}超时`)), 15000);
      tx.oncomplete = () => {
        clearTimeout(timer);
        resolve();
      };
      tx.onerror = () => {
        clearTimeout(timer);
        reject(tx.error || new Error(`${label}失败`));
      };
      tx.onabort = () => {
        clearTimeout(timer);
        reject(tx.error || new Error(`${label}中止`));
      };
    });
  }

  async function savePageToDB(page) {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(page);
    return waitTransaction(tx, 'IndexedDB 写入');
  }

  async function loadAllPages() {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IndexedDB 读取超时')), 15000);
      req.onsuccess = () => {
        clearTimeout(timer);
        const list = req.result || [];
        list.sort((a, b) => a.index - b.index);
        resolve(list);
      };
      req.onerror = () => {
        clearTimeout(timer);
        reject(req.error || new Error('IndexedDB 读取失败'));
      };
      tx.onabort = () => {
        clearTimeout(timer);
        reject(tx.error || new Error('IndexedDB 读取中止'));
      };
    });
  }

  async function clearDB() {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    return waitTransaction(tx, 'IndexedDB 清空');
  }

  function getReaderContainer() {
    const precise = [
      '.readerChapterContent_container',
      '.readerChapterContent',
      '.wr_readerChapterContent',
      '[class*="readerChapterContent"]',
      '[class*="chapterContent"]',
      '[class*="readerChapter"]',
      '.content',
      '.readerContent'
    ];
    for (const sel of precise) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 200 && r.height > 150) return el;
      }
    }
    const canvases = [...document.querySelectorAll('canvas')];
    let best = null;
    let maxArea = 0;
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > maxArea && r.width > 200 && r.height > 200) {
        maxArea = area;
        best = c;
      }
    }
    if (best) {
      let parent = best.parentElement;
      for (let i = 0; i < 3 && parent; i++) {
        const pr = parent.getBoundingClientRect();
        if (pr.width > 400 && pr.height > 300 && pr.width < window.innerWidth * 0.95) {
          return parent;
        }
        parent = parent.parentElement;
      }
      return best.parentElement || best;
    }
    return document.querySelector('.wr_reader') || document.body;
  }

  let saving = false;
  let capturing = false;

  function getCaptureTarget() {
    let target = getReaderContainer();
    const frame = target.querySelector?.('iframe');
    if (frame) {
      try {
        if (frame.contentDocument?.body) target = frame.contentDocument.body;
      } catch (e) {}
    }
    return target;
  }

  function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function getPageIdentity(target) {
    let text = '';
    try {
      text = (target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {}
    if (text.length >= 20) {
      return 't:' + hashString(`${location.pathname}|${text}`);
    }
    const label = document.querySelector(
      '[class*="pageNumber"], [class*="page-number"], [class*="chapterTitle"], [class*="chapter-title"]'
    )?.textContent || '';
    const scroll = `${window.scrollX},${window.scrollY},${target.scrollTop || 0}`;
    return 'p:' + hashString(`${location.pathname}|${label}|${scroll}`);
  }

  async function captureToDataURL(target = getCaptureTarget()) {
    const scale = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
    const canvas = await html2canvas(target, {
      scale,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      logging: false,
      ignoreElements: (el) => el === host
    });
    return canvas.toDataURL('image/png');
  }

  let toastTimer = null;

  function showToast(text, isError = false) {
    if (!shadow) return;
    const toast = shadow.getElementById('scan-toast');
    const panel = shadow.querySelector('.panel');
    if (toast) {
      toast.textContent = text;
      toast.classList.toggle('error', !!isError);
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
    }
    if (panel) {
      panel.classList.add('flash');
      setTimeout(() => panel.classList.remove('flash'), 450);
    }
  }

  async function saveCurrentPage() {
    if (saving) return;
    if (!db) {
      showToast('截图存储尚未就绪', true);
      return;
    }
    saving = true;
    capturing = true;
    const saveBtn = shadow?.getElementById('btnSave');
    if (saveBtn) saveBtn.disabled = true;
    updateScanStatus('截图中…');
    showToast('截图中…');

    let page = null;
    let previousData = null;
    let previousTime = null;
    try {
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      const target = getCaptureTarget();
      const identity = getPageIdentity(target);
      const dataURL = await captureToDataURL(target);
      if (typeof dataURL !== 'string' || !dataURL.startsWith('data:image/')) {
        throw new Error('截图数据无效');
      }
      page = pages.find(p => p.identity === identity) || null;
      if (page) {
        previousData = page.dataURL;
        previousTime = page.time;
        page.dataURL = dataURL;
        page.time = new Date().toISOString();
      } else {
        const nextIndex = pages.reduce((max, p) => Math.max(max, Number(p.index) || 0), 0) + 1;
        page = { index: nextIndex, identity, dataURL, time: new Date().toISOString() };
        pages.push(page);
      }
      await savePageToDB(page);
      updateScanStatus();
      showToast(previousData != null ? `已更新第 ${page.index} 页` : `已保存第 ${page.index} 页`);
    } catch (e) {
      console.error('保存失败', e);
      if (page) {
        if (previousData != null) {
          page.dataURL = previousData;
          page.time = previousTime;
        } else {
          const idx = pages.indexOf(page);
          if (idx >= 0) pages.splice(idx, 1);
        }
      }
      showToast('保存失败：' + (e.message || e), true);
    } finally {
      saving = false;
      capturing = false;
      if (saveBtn) saveBtn.disabled = false;
      updateScanStatus();
    }
  }

  let fontObserver = null;
  let fontPatchTimer = null;
  let activeFaceCss = '';
  let activeFallbackCss = '';

  function buildFace(name, fontName, range, fallbacks = []) {
    const sources = [fontName, ...fallbacks]
      .filter(Boolean)
      .map(font => (LOCAL_FONT_ALIASES[font] || [font]).map(alias => `local("${alias}")`).join(', '))
      .join(', ');
    return `@font-face {
      font-family: "${name}";
      src: ${sources};
      unicode-range: ${range};
      font-display: swap;
    }`;
  }

  function buildMainStack() {
    const fonts = [];
    const push = (key) => {
      const item = fontSettings[key];
      const name = item?.enabled && item?.font ? item.font : '';
      if (name && !fonts.includes(`"${name}"`)) fonts.push(`"${name}"`);
    };
    if (fontSettings.enMode === 'force') {
      push(['sans', 'serif', 'mono'].includes(fontSettings.forceEn) ? fontSettings.forceEn : 'serif');
    } else {
      // 兜底先给英文 face，避免英文落到中文字体的拉丁字形；中文靠后面的中文字体接住
      push('serif');
    }
    push('zh');
    push('sans');
    push('serif');
    return fonts.length ? fonts.join(', ') + ', sans-serif' : '';
  }

  function buildCodeStack() {
    const fonts = [];
    if (fontSettings.enMode === 'force') {
      const key = ['sans', 'serif', 'mono'].includes(fontSettings.forceEn) ? fontSettings.forceEn : 'serif';
      const forced = fontSettings[key];
      if (forced?.enabled && forced?.font) fonts.push(`"${forced.font}"`);
    } else if (fontSettings.mono?.enabled && fontSettings.mono?.font) {
      fonts.push(`"${fontSettings.mono.font}"`);
    }
    if (fontSettings.zh?.enabled && fontSettings.zh?.font) fonts.push(`"${fontSettings.zh.font}"`);
    return fonts.length ? fonts.join(', ') + ', monospace' : '';
  }

  function buildFallbackCss() {
    const main = buildMainStack();
    if (!main) return '';
    const code = buildCodeStack();
    const scope = '[data-weread-font-root]';
    return `
    ${scope}, ${scope} *:not(script):not(style):not(noscript):not(template):not(svg):not(button):not(input):not(textarea):not(select):not([role="button"]):not([class*="icon"]):not([class*="Icon"]) {
      font-family: ${main} !important;
    }
    ${code ? `${scope} code, ${scope} pre, ${scope} kbd, ${scope} samp { font-family: ${code} !important; }` : ''}`;
  }

  function getFontStyle(doc = document) {
    let style = doc.getElementById('weread-custom-fonts');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'weread-custom-fonts';
      (doc.head || doc.documentElement).appendChild(style);
    }
    return style;
  }

  function getComputedFamily(el) {
    try {
      const win = el.ownerDocument?.defaultView;
      return win ? win.getComputedStyle(el).fontFamily : '';
    } catch (e) {
      return '';
    }
  }

  const boundFrames = new WeakSet();

  function bindIframe(iframe) {
    if (boundFrames.has(iframe)) return;
    boundFrames.add(iframe);
    iframe.addEventListener('load', () => {
      setTimeout(() => {
        try {
          if (iframe.contentDocument) applyFonts();
        } catch (e) {}
      }, 0);
    });
  }

  // 1.2 的全局 CSS 能覆盖正文，1.3 只看 getReaderContainer 会漏掉窄容器/iframe/shadow。
  // 这里从整页出发，连同开着的 shadow root 和同源 iframe 一起扫。
  const FONT_ROOT_SELECTORS = [
    '.readerChapterContent_container',
    '.readerChapterContent',
    '.wr_readerChapterContent',
    '[class*="readerChapterContent"]',
    '[class*="chapterContent"]',
    '[class*="readerChapter"]',
    '.readerContent',
  ];

  function getFontRoot(doc = document) {
    for (const sel of FONT_ROOT_SELECTORS) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return doc.body;
  }

  function collectFontRoots(doc = document, out = [], seen = new Set()) {
    if (!doc || seen.has(doc)) return out;
    seen.add(doc);
    const root = getFontRoot(doc);
    if (!root) return out;
    if (root.nodeType === 1) root.setAttribute('data-weread-font-root', '1');
    out.push(root);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (el.shadowRoot && el !== host) out.push(el.shadowRoot);
    }
    root.querySelectorAll('iframe').forEach(iframe => {
      bindIframe(iframe);
      try {
        const idoc = iframe.contentDocument;
        if (idoc?.body) {
          collectFontRoots(idoc, out, seen);
        }
      } catch (e) {}
    });
    return out;
  }

  function splitFamilies(family) {
    const s = String(family || '');
    const out = [];
    let current = '';
    let quote = '';
    for (const ch of s) {
      if (quote) {
        if (ch === quote) quote = '';
        else current += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ',') {
        if (current.trim()) out.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) out.push(current.trim());
    return out;
  }

  function stripCustomFaces(family) {
    return splitFamilies(family)
      .filter(name => !/^WR-(?:sans|serif|mono|CJK)$/i.test(name))
      .join(', ');
  }

  function classifyFace(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return '';
    if (['monospace', 'ui-monospace'].includes(n)) return 'mono';
    if (['sans-serif', 'system-ui', 'ui-sans-serif'].includes(n)) return 'sans';
    if (['serif', 'ui-serif'].includes(n)) return 'serif';
    if (/mono|code|courier|consolas|menlo|monaco|cascadia|fira|jetbrains|inconsolata|hack/.test(n)) return 'mono';
    if (/serif|garamond|times|georgia|stempel|officina|valkyrie|baskerville|caslon|sabon|minion|palatino|cambria|song|sung|simsun|mincho|ming|宋|明|楷|仿宋/.test(n)) return 'serif';
    if (/sans|inter|arial|helvetica|segoe|roboto|lato|hei|yahei|pingfang|黑|gothic/.test(n)) return 'sans';
    return '';
  }

  function faceFromFamily(family) {
    for (const name of splitFamilies(stripCustomFaces(family))) {
      const face = classifyFace(name);
      if (face) return face;
    }
    return '';
  }

  function faceFromClass(el) {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const tokens = String(node.className || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.some(token => token === 'mono' || token === 'font-mono' || token === 'code' || token.endsWith('-code') || token.startsWith('code-'))) return 'mono';
      if (tokens.some(token => token === 'serif' || token === 'font-serif')) return 'serif';
      if (tokens.some(token => token === 'sans' || token === 'font-sans' || token === 'sans-serif')) return 'sans';
    }
    return '';
  }

  function bookFaceFor(el, family) {
    return faceFromClass(el) || faceFromFamily(family);
  }

  function ruleRole(el) {
    if (el.closest?.(CODE_SELECTOR)) return 'mono';
    if (el.closest?.(HEADING_SELECTOR)) return 'sans';
    return 'serif';
  }

  function roleForElement(el) {
    if (fontSettings.enMode === 'force') {
      return ['sans', 'serif', 'mono'].includes(fontSettings.forceEn)
        ? fontSettings.forceEn
        : 'serif';
    }
    if (fontSettings.enMode === 'book') {
      return bookFaceFor(el, getComputedFamily(el)) || ruleRole(el);
    }
    return ruleRole(el);
  }

  function enabledLatinFace(role) {
    const order = {
      sans: ['sans', 'serif', 'mono'],
      serif: ['serif', 'sans', 'mono'],
      mono: ['mono'],
    }[role] || ['serif', 'sans', 'mono'];
    return order.find(key => fontSettings[key]?.enabled && fontSettings[key]?.font) || '';
  }

  function undoFontPatches() {
    collectFontRoots().forEach(root => {
      root.querySelectorAll(`[${PATCH_ATTR}]`).forEach(el => {
        try {
          el.style.fontFamily = el.getAttribute(ORIG_ATTR) || '';
        } catch (e) {}
        el.removeAttribute(PATCH_ATTR);
        el.removeAttribute(ORIG_ATTR);
      });
    });
  }

  function patchFontElement(el) {
    if (!el || el.nodeType !== 1 || !el.style) return;
    if (el.closest?.('script, style, noscript, template, button, [role="button"], input, textarea, select, svg, [class*="icon"]')) return;
    const role = roleForElement(el);
    if (el.getAttribute(PATCH_ATTR) === role) return;

    const latinFace = enabledLatinFace(role);
    const cjkFace = (fontSettings.zh?.enabled && fontSettings.zh?.font) ? '"WR-CJK"' : '';
    const latin = latinFace ? `"WR-${latinFace}"` : '';
    const stack = [latin, cjkFace].filter(Boolean).join(', ');
    if (!stack) return;

    if (!el.hasAttribute(ORIG_ATTR)) {
      el.setAttribute(ORIG_ATTR, el.style.fontFamily || '');
    } else {
      el.style.fontFamily = el.getAttribute(ORIG_ATTR) || '';
    }

    const computed = getComputedFamily(el);
    el.style.setProperty('font-family', `${stack}, ${computed}`, 'important');
    el.setAttribute(PATCH_ATTR, role);
  }

  function patchReaderFonts() {
    const roots = collectFontRoots();
    const docs = new Set([document]);
    roots.forEach(root => {
      if (root.ownerDocument) docs.add(root.ownerDocument);
    });
    // 书籍设定要读原书 face，不能让全局兜底污染 getComputedFamily；补丁期间临时撤掉兜底。
    const suspend = fontSettings.enMode === 'book' && !!activeFallbackCss;
    if (suspend) {
      docs.forEach(doc => {
        if (doc.documentElement) getFontStyle(doc).textContent = activeFaceCss;
      });
      roots.filter(root => root.nodeType === 11).forEach(root => {
        const style = root.getElementById?.('weread-shadow-fonts');
        if (style) style.textContent = '';
      });
    }
    try {
      for (const root of roots) {
        if (!root?.querySelectorAll) continue;
        const doc = root.ownerDocument || document;
        const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return (node.nodeValue && TEXT_REGEX.test(node.nodeValue))
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          }
        });
        let node;
        while ((node = walker.nextNode())) {
          patchFontElement(node.parentElement);
        }
      }
    } finally {
      if (suspend) {
        docs.forEach(doc => {
          if (doc.documentElement) {
            getFontStyle(doc).textContent = activeFaceCss + '\n' + activeFallbackCss;
          }
        });
        const shadowCss = activeFallbackCss.split('[data-weread-font-root]').join(':host');
        roots.filter(root => root.nodeType === 11).forEach(root => {
          let style = root.getElementById?.('weread-shadow-fonts');
          if (!style) {
            style = (root.ownerDocument || document).createElement('style');
            style.id = 'weread-shadow-fonts';
            root.appendChild(style);
          }
          style.textContent = shadowCss;
        });
      }
    }
  }

  function observeFontMutations() {
    fontObserver?.disconnect();
    const roots = collectFontRoots();
    if (!roots.length) return;
    fontObserver = new MutationObserver(() => {
      if (capturing) return;
      clearTimeout(fontPatchTimer);
      fontPatchTimer = setTimeout(patchReaderFonts, 300);
    });
    roots.forEach(root => {
      try {
        fontObserver.observe(root, { childList: true, subtree: true });
      } catch (e) {}
    });
  }

  function applyFonts() {
    const faces = [];
    if (fontSettings.zh?.enabled && fontSettings.zh?.font) {
      faces.push(buildFace('WR-CJK', fontSettings.zh.font, CJK_RANGE));
    }
    for (const key of ['sans', 'serif', 'mono']) {
      const item = fontSettings[key];
      if (item?.enabled && item?.font) {
        faces.push(buildFace(`WR-${key}`, item.font, LATIN_RANGE, LATIN_FALLBACKS[key]));
      }
    }
    const faceCss = faces.join('\n');
    const roots = collectFontRoots();
    const docs = new Set([document]);
    roots.forEach(root => {
      if (root.ownerDocument) docs.add(root.ownerDocument);
    });
    activeFaceCss = faceCss;
    activeFallbackCss = buildFallbackCss();
    const fallbackCss = activeFallbackCss;

    // 先撤掉全局兜底，让 getComputedFamily 读到原书字体，再打角色补丁；
    // 补丁完成后再加兜底，兜底只接住没被打到的节点。
    docs.forEach(doc => {
      if (doc.documentElement) getFontStyle(doc).textContent = faceCss;
    });
    roots.filter(root => root.nodeType === 11).forEach(root => {
      const style = root.getElementById?.('weread-shadow-fonts');
      if (style) style.textContent = '';
    });

    undoFontPatches();
    patchReaderFonts();

    docs.forEach(doc => {
      if (doc.documentElement) {
        getFontStyle(doc).textContent = faceCss + '\n' + fallbackCss;
      }
    });
    const shadowCss = fallbackCss.split('[data-weread-font-root]').join(':host');
    if (shadowCss) {
      roots.filter(root => root.nodeType === 11).forEach(root => {
        let style = root.getElementById?.('weread-shadow-fonts');
        if (!style) {
          style = (root.ownerDocument || document).createElement('style');
          style.id = 'weread-shadow-fonts';
          root.appendChild(style);
        }
        style.textContent = shadowCss;
      });
    }
    observeFontMutations();
  }

  function createPanel() {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        .panel {
          background:#f7f6f3;color:#2c2c2c;border-radius:10px;
          font-size:12px;font-family:system-ui,sans-serif;
          box-shadow:0 4px 16px rgba(0,0,0,.12);width:120px;user-select:none;
        }
        .header {
          padding:8px 10px;cursor:move;background:#efece6;
          border-radius:10px 10px 0 0;font-weight:600;text-align:center;
        }
        .body { padding:8px 10px; }
        button {
          width:100%;padding:6px 0;margin-bottom:5px;cursor:pointer;border:none;border-radius:6px;
          font-size:12px;background:#fff;color:#333;
        }
        button.danger { background:#e8e6e3; }
        .panel.flash { box-shadow:0 0 0 3px rgba(46,125,50,.5), 0 4px 16px rgba(0,0,0,.12); }
        .status { color:#666;font-size:11px;margin-bottom:6px;text-align:center; }
        .toast { min-height:14px;margin-top:4px;font-size:11px;color:#2e7d32;text-align:center;opacity:0;transition:opacity .18s; }
        .toast.show { opacity:1; }
        .toast.error { color:#c62828; }
        .font-panel {
          display:none;position:absolute;top:0;right:130px;width:220px;
          background:#f7f6f3;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.12);padding:10px;
        }
        .font-panel.open { display:block; }
        .font-header { display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-weight:600; }
        .close { cursor:pointer;font-size:16px; }
        .row { margin-bottom:8px; }
        .switch { display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;font-size:12px; }
        select { width:100%;padding:4px;border:1px solid #ddd;border-radius:4px;font-size:12px; }
        .force-row { margin-top:6px; }
      </style>
      <div class="panel">
        <div class="header" id="scan-header">扫描</div>
        <div class="body">
          <div class="status" id="scan-status">0 页</div>
          <button id="btnSave">保存</button>
          <button id="btnCurrent">下载当前</button>
          <button id="btnZip">下载全部</button>
          <button id="btnFont">字体</button>
          <button class="danger" id="btnClear">清空</button>
          <div class="toast" id="scan-toast"></div>
        </div>
      </div>
      <div class="font-panel" id="font-panel">
        <div class="font-header">
          <span>字体设置</span>
          <span class="close" id="font-close">×</span>
        </div>
        <div class="row">
          <div class="switch"><span>中文</span><input type="checkbox" id="zh-en"></div>
          <select id="zh-font"></select>
        </div>
        <div class="row">
          <div class="switch"><span>Sans</span><input type="checkbox" id="sans-en"></div>
          <select id="sans-font"></select>
        </div>
        <div class="row">
          <div class="switch"><span>Serif</span><input type="checkbox" id="serif-en"></div>
          <select id="serif-font"></select>
        </div>
        <div class="row">
          <div class="switch"><span>Mono</span><input type="checkbox" id="mono-en"></div>
          <select id="mono-font"></select>
        </div>
        <div class="force-row">
          <div style="margin-bottom:4px;font-size:12px;">字体应用策略</div>
          <select id="en-mode">
            <option value="book">书籍设定（按书中 face）</option>
            <option value="rules">规则设定（标题 Sans / 正文 Serif / 代码 Mono）</option>
            <option value="force">强制设定</option>
          </select>
          <select id="force-en" style="margin-top:6px;">
            <option value="sans">Sans</option>
            <option value="serif">Serif</option>
            <option value="mono">Mono</option>
          </select>
          <div id="strategy-hint" style="margin-top:4px;font-size:11px;color:#999;"></div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(host);

    // 填充下拉框
    function fillSelect(id, options, current) {
      const sel = shadow.getElementById(id);
      sel.innerHTML = options.map(f => `<option value="${f}" ${f === current ? 'selected' : ''}>${f}</option>`).join('');
    }
    fillSelect('zh-font', fontOptions.zh, fontSettings.zh.font);
    fillSelect('sans-font', fontOptions.sans, fontSettings.sans.font);
    fillSelect('serif-font', fontOptions.serif, fontSettings.serif.font);
    fillSelect('mono-font', fontOptions.mono, fontSettings.mono.font);

    // 拖动
    const header = shadow.getElementById('scan-header');
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    header.onmousedown = e => {
      e.preventDefault();
      pos3 = e.clientX; pos4 = e.clientY;
      const move = e2 => {
        e2.preventDefault();
        pos1 = pos3 - e2.clientX; pos2 = pos4 - e2.clientY;
        pos3 = e2.clientX; pos4 = e2.clientY;
        host.style.top = (host.offsetTop - pos2) + 'px';
        host.style.left = (host.offsetLeft - pos1) + 'px';
        host.style.right = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };

    // 字体面板开关
    const fontPanel = shadow.getElementById('font-panel');
    shadow.getElementById('btnFont').onclick = () => {
      fontPanelOpen = !fontPanelOpen;
      fontPanel.classList.toggle('open', fontPanelOpen);
    };
    shadow.getElementById('font-close').onclick = () => {
      fontPanelOpen = false;
      fontPanel.classList.remove('open');
    };

    // 绑定字体控件
    const bindCheck = (id, key) => {
      const el = shadow.getElementById(id);
      el.checked = fontSettings[key].enabled;
      el.onchange = () => { fontSettings[key].enabled = el.checked; saveFontSettings(); };
    };
    const bindSelect = (id, key) => {
      const el = shadow.getElementById(id);
      el.onchange = () => { fontSettings[key].font = el.value; saveFontSettings(); };
    };

    bindCheck('zh-en', 'zh');
    bindSelect('zh-font', 'zh');
    bindCheck('sans-en', 'sans');
    bindSelect('sans-font', 'sans');
    bindCheck('serif-en', 'serif');
    bindSelect('serif-font', 'serif');
    bindCheck('mono-en', 'mono');
    bindSelect('mono-font', 'mono');

    const enModeEl = shadow.getElementById('en-mode');
    const forceEl = shadow.getElementById('force-en');
    const hintEl = shadow.getElementById('strategy-hint');
    enModeEl.value = fontSettings.enMode;
    forceEl.value = fontSettings.forceEn;
    const updateStrategyHint = () => {
      if (fontSettings.enMode === 'book') {
        hintEl.textContent = '中文仍用面板字体；按书中 serif/sans/mono 标记套用面板对应字体，未标记时按规则。';
      } else if (fontSettings.enMode === 'rules') {
        hintEl.textContent = '中文仍用面板字体；标题英文 Sans、正文英文 Serif、代码 Mono。';
      } else {
        const label = { sans: 'Sans', serif: 'Serif', mono: 'Mono' }[fontSettings.forceEn] || 'Serif';
        hintEl.textContent = `中文仍用面板字体；英文（含代码）统一 ${label}。`;
      }
    };
    const updateForceVisibility = () => {
      forceEl.style.display = fontSettings.enMode === 'force' ? '' : 'none';
    };
    updateStrategyHint();
    updateForceVisibility();
    enModeEl.onchange = () => {
      fontSettings.enMode = enModeEl.value;
      updateStrategyHint();
      updateForceVisibility();
      saveFontSettings();
    };
    forceEl.onchange = () => {
      fontSettings.forceEn = forceEl.value;
      updateStrategyHint();
      saveFontSettings();
    };

    // 扫描按钮
    shadow.getElementById('btnSave').onclick = saveCurrentPage;
    shadow.getElementById('btnCurrent').onclick = downloadCurrentPage;
    shadow.getElementById('btnZip').onclick = downloadAllImages;
    shadow.getElementById('btnClear').onclick = async () => {
      if (!db) return alert('截图存储尚未就绪');
      if (confirm('清空所有已保存页面？')) {
        try {
          pages = [];
          await clearDB();
          updateScanStatus();
        } catch (e) {
          console.error('清空失败', e);
          alert('清空失败：' + (e.message || e));
        }
      }
    };
  }

  function updateScanStatus(text) {
    const el = shadow?.getElementById('scan-status');
    if (el) el.textContent = text || `${pages.length} 页`;
  }

  function pad4(n) { return String(n).padStart(4, '0'); }

  function dataURLToBlob(dataURL) {
    if (typeof dataURL !== 'string' || !dataURL.startsWith('data:')) {
      throw new Error('截图数据为空');
    }
    const comma = dataURL.indexOf(',');
    if (comma < 0) throw new Error('截图数据格式错误');
    const meta = dataURL.slice(5, comma);
    const mime = meta.split(';')[0] || 'image/png';
    const body = dataURL.slice(comma + 1);
    let bytes;
    if (/;base64/i.test(meta)) {
      const bin = atob(body);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }
    return new Blob([bytes], { type: mime });
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function downloadCurrentPage() {
    if (!pages.length) return alert('还没有截图');
    const p = pages[pages.length - 1];
    try {
      triggerBlobDownload(dataURLToBlob(p.dataURL), `page_${pad4(p.index)}.png`);
      showToast(`已导出第 ${p.index} 页`);
    } catch (e) {
      console.error('导出失败', e);
      showToast('导出失败：' + (e.message || e), true);
    }
  }

  async function downloadAllImages() {
    if (!pages.length) return alert('还没有截图');
    showToast(`正在导出 ${pages.length} 张…`);
    let ok = 0;
    let failed = 0;
    for (const p of pages) {
      try {
        triggerBlobDownload(dataURLToBlob(p.dataURL), `page_${pad4(p.index)}.png`);
        ok += 1;
      } catch (e) {
        failed += 1;
        console.error(`导出第 ${p.index} 页失败`, e);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    showToast(failed ? `已导出 ${ok} 张，${failed} 张失败` : `已导出 ${ok} 张`, !!failed);
  }

  async function init() {
    createPanel();
    updateScanStatus();
    applyFonts();
    try {
      db = await openDB();
      pages = await loadAllPages();
      updateScanStatus();
    } catch (e) {
      console.error('截图存储不可用', e);
      updateScanStatus('存储不可用');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();