// ==UserScript==
// @name         微信读书扫描 + 字体
// @namespace    https://weread.qq.com/
// @version      1.1
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
    forceEn: ''   // '', 'sans', 'serif', 'mono'
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
      return raw ? { ...defaultFontSettings, ...JSON.parse(raw) } : { ...defaultFontSettings };
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
      req.onupgradeneeded = e => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'index' });
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e);
    });
  }

  async function savePageToDB(page) {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(page);
    return new Promise(r => tx.oncomplete = r);
  }

  async function loadAllPages() {
    const tx = db.transaction(STORE_NAME, 'readonly');
    return new Promise(resolve => {
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const list = req.result || [];
        list.sort((a, b) => a.index - b.index);
        resolve(list);
      };
    });
  }

  async function clearDB() {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    return new Promise(r => tx.oncomplete = r);
  }

  function getReaderContainer() {
    const precise = [
      '.readerChapterContent',
      '.wr_readerChapterContent',
      '[class*="chapterContent"]',
      '[class*="readerChapter"]',
      '.content',
      '.readerContent'
    ];
    for (const sel of precise) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 300 && r.height > 200) return el;
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

  async function captureToDataURL() {
    const target = getReaderContainer();
    const scale = Math.max(2, window.devicePixelRatio || 1);
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

  async function saveCurrentPage() {
    try {
      const dataURL = await captureToDataURL();
      let page;
      if (pages.length === 0) {
        page = { index: 1, dataURL, time: new Date().toISOString() };
        pages.push(page);
      } else {
        page = pages[pages.length - 1];
        page.dataURL = dataURL;
        page.time = new Date().toISOString();
      }
      await savePageToDB(page);
      updateScanStatus();
    } catch (e) {
      console.error('保存失败', e);
      alert('保存失败：' + (e.message || e));
    }
  }

  function applyFonts() {
    let style = document.getElementById('weread-custom-fonts');
    if (!style) {
      style = document.createElement('style');
      style.id = 'weread-custom-fonts';
      document.documentElement.appendChild(style);
    }

    const mainFonts = [];
    if (fontSettings.zh.enabled && fontSettings.zh.font) mainFonts.push(`"${fontSettings.zh.font}"`);
    if (fontSettings.sans.enabled && fontSettings.sans.font) mainFonts.push(`"${fontSettings.sans.font}"`);
    if (fontSettings.serif.enabled && fontSettings.serif.font) mainFonts.push(`"${fontSettings.serif.font}"`);

    let mainStack = mainFonts.length ? mainFonts.join(', ') + ', sans-serif' : 'sans-serif';

    if (fontSettings.forceEn === 'sans' && fontSettings.sans.font) {
      mainStack = `"${fontSettings.sans.font}", ${mainStack}`;
    } else if (fontSettings.forceEn === 'serif' && fontSettings.serif.font) {
      mainStack = `"${fontSettings.serif.font}", ${mainStack}`;
    } else if (fontSettings.forceEn === 'mono' && fontSettings.mono.font) {
      mainStack = `"${fontSettings.mono.font}", ${mainStack}`;
    }

    const rules = [`* { font-family: ${mainStack} !important; }`];

    if (fontSettings.mono.enabled && fontSettings.mono.font) {
      rules.push(`code, pre, kbd, samp, .mono, [class*="mono"], [class*="code"] {
        font-family: "${fontSettings.mono.font}", ui-monospace, monospace !important;
      }`);
    }

    style.textContent = rules.join('\n');
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
        .status { color:#666;font-size:11px;margin-bottom:6px;text-align:center; }
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
          <div style="margin-bottom:4px;font-size:12px;">英文强制</div>
          <select id="force-en">
            <option value="">不选</option>
            <option value="sans">Sans</option>
            <option value="serif">Serif</option>
            <option value="mono">Mono</option>
          </select>
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

    const forceEl = shadow.getElementById('force-en');
    forceEl.value = fontSettings.forceEn;
    forceEl.onchange = () => { fontSettings.forceEn = forceEl.value; saveFontSettings(); };

    // 扫描按钮
    shadow.getElementById('btnSave').onclick = saveCurrentPage;
    shadow.getElementById('btnCurrent').onclick = downloadCurrentPage;
    shadow.getElementById('btnZip').onclick = downloadAllImages;
    shadow.getElementById('btnClear').onclick = async () => {
      if (confirm('清空所有已保存页面？')) {
        pages = [];
        await clearDB();
        updateScanStatus();
      }
    };
  }

  function updateScanStatus() {
    const el = shadow?.getElementById('scan-status');
    if (el) el.textContent = `${pages.length} 页`;
  }

  function pad4(n) { return String(n).padStart(4, '0'); }

  function downloadCurrentPage() {
    if (!pages.length) return alert('还没有截图');
    const p = pages[pages.length - 1];
    const a = document.createElement('a');
    a.href = p.dataURL;
    a.download = `page_${pad4(p.index)}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadAllImages() {
    if (!pages.length) return alert('还没有截图');
    pages.forEach(p => {
      const a = document.createElement('a');
      a.href = p.dataURL;
      a.download = `page_${pad4(p.index)}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  async function init() {
    db = await openDB();
    pages = await loadAllPages();
    createPanel();
    updateScanStatus();
    applyFonts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();