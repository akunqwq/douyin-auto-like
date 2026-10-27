// ==UserScript==
// @name         抖音自动点赞（Z 键通道）
// @version      1.7.0
// @description  支持实时监测视频播放状态，自动点赞未点赞视频，支持跨日统计和导出今日数据。
// @author       阿鲲
// @match        https://www.douyin.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/akunqwq/douyin-auto-like/main/douyin-auto-like.user.js
// @downloadURL  https://raw.githubusercontent.com/akunqwq/douyin-auto-like/main/douyin-auto-like.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ============ 可调参数 ============ */
  const CFG = {
    pollMs: 300   // 状态检测间隔（毫秒）
  };

  let running = true; // 运行状态开关

  /* ============ 跨日持久化与状态机初始化 ============ */
  const todayStr = new Date().toISOString().slice(0, 10);
  let storedData = GM_getValue('dy_auto_like_data', { date: todayStr, records: {} });

  // 跨日清零
  if (storedData.date !== todayStr) {
    storedData = { date: todayStr, records: {} };
    GM_setValue('dy_auto_like_data', storedData);
  }

  let records = storedData.records;

  function saveRecords() {
    GM_setValue('dy_auto_like_data', { date: todayStr, records });
  }

  // 动态派生真实点赞数：仅统计当前状态为 LIKED 的视频
  function getLikedCount() {
    return Object.values(records).filter(r => r.status === 'LIKED').length;
  }

  /* ============ 注册油猴菜单：导出今日数据 ============ */
  GM_registerMenuCommand("导出今日点赞数据 (JSON)", () => {
    const exportData = {
      date: todayStr,
      totalLiked: getLikedCount(),
      records: records
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `douyin_likes_${todayStr}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  });

  // 每个 video 独立采样 currentTime
  const _samples = new Map();

  /* ============ 核心：模拟按下 Z ============ */
  function fireZ() {
    const ev = new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      bubbles: true,
      cancelable: true,
      composed: true
    });
    Object.defineProperty(ev, 'keyCode', { get: () => 90 });
    Object.defineProperty(ev, 'which', { get: () => 90 });
    document.body.dispatchEvent(ev);
  }

  /* ============ 获取当前激活视频 ============ */
  function getCurrentVideoItem() {
    const modalActive = document.querySelector('[role="dialog"] [data-e2e="feed-active-video"], .video-detail-modal [data-e2e="feed-active-video"], #sliderVideo');
    if (modalActive) {
      const v = modalActive.querySelector('video');
      const vid = modalActive.getAttribute('data-e2e-vid') || (v ? v.getAttribute('data-e2e-vid') : '');
      if (v) return { container: modalActive, video: v, vid: vid || 'modal_' + Math.random() };
    }

    const active = document.querySelector('[data-e2e="feed-active-video"]');
    if (!active) return null;

    const v = active.querySelector('video');
    if (!v) return null;

    const rect = active.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 过滤首页网格缩略图
    if (rect.height < vh * 0.4 && rect.width < vw * 0.5) {
      return null;
    }

    const vid = active.getAttribute('data-e2e-vid') || '';
    return { container: active, video: v, vid };
  }

  /* ============ 判断是否真的在播放 ============ */
  function isPlaying(v) {
    const now = Date.now();
    const ct = v.currentTime;
    const s = _samples.get(v);

    if (!s) {
      _samples.set(v, { t: ct, ts: now });
      return false;
    }

    if (now - s.ts < 100) return false;

    const growing = ct > s.t + 0.05;
    _samples.set(v, { t: ct, ts: now });
    return growing;
  }

  /* ============ 判断点赞状态 ============ */
  function diggState(btn) {
    const state = btn.getAttribute('data-e2e-state');
    if (state === 'video-player-is-digged') return true;   // 已赞
    if (state === 'video-player-no-digged') return false;  // 未赞

    const svg = btn.querySelector('svg');
    if (svg) {
      const fill = getComputedStyle(svg).fill || svg.getAttribute('fill') || '';
      if (/254,\s*44,\s*85|fe2c55/i.test(fill)) return true;
    }
    return /active|liked|digged/i.test(btn.className || '');
  }

  function isLiked(container, v) {
    const DIGG = '[data-e2e="video-player-digg"], [data-e2e="feed-digg"]';

    if (container) {
      const btn = container.querySelector(DIGG);
      if (btn) return diggState(btn);
    }

    let node = v && v.parentElement;
    let depth = 0;
    while (node && node !== document.documentElement && depth < 15) {
      const btn = node.querySelector(DIGG);
      if (btn) return diggState(btn);
      node = node.parentElement;
      depth++;
    }

    const fallback = document.querySelector(DIGG);
    return fallback ? diggState(fallback) : false;
  }

  /* ============ 全双工状态机核心循环 ============ */
  function tick() {
    if (!running || document.hidden) return;

    for (const key of _samples.keys()) {
      if (!document.contains(key)) _samples.delete(key);
    }

    const item = getCurrentVideoItem();
    if (!item || !item.video) {
      setStatus('等待进入视频播放…', '#f5a623');
      return;
    }

    const { container, video: v, vid } = item;
    if (!vid) {
      setStatus('视频加载中…', '#f5a623');
      return;
    }

    // 初始化状态机记录
    if (!records[vid]) {
      records[vid] = {
        vid: vid,
        status: 'NEW', // NEW -> PLAYING -> LIKED / SKIPPED / UNLIKED
        firstSeen: Date.now(),
        actionTime: null,
        title: document.title || ''
      };
      saveRecords();
    }

    const rec = records[vid];
    const currentlyLiked = isLiked(container, v);

    // 1. 当用户手动取消点赞 (!currentlyLiked) -> 降级为 UNLIKED，扣除计数
    if (rec.status === 'LIKED' && !currentlyLiked) {
      const elapsed = rec.actionTime ? Date.now() - rec.actionTime : 99999; // 计算距离点赞动作的时间间隔
      if (elapsed > 1500) {
        rec.status = 'UNLIKED';
        saveRecords();
        setStatus('已取消点赞，扣除计数', '#f5a623');
        return;
      }
    }

    // 2. 当用户手动重新点赞 (currentlyLiked) -> 恢复计数
    if (rec.status === 'UNLIKED' && currentlyLiked) {
      rec.status = 'LIKED';
      rec.actionTime = Date.now();
      saveRecords();
      setStatus('重新点赞，恢复计数 (' + getLikedCount() + ')', '#fe2c55');
      return;
    }

    // 如果已经是终态 SKIPPED
    if (rec.status === 'SKIPPED') {
      setStatus('已点赞，跳过', '#999');
      return;
    }

    // 如果当前已经是 LIKED 且状态保持一致
    if (rec.status === 'LIKED') {
      setStatus('已点赞 (' + getLikedCount() + ')', '#fe2c55');
      return;
    }

    // 如果当前是 UNLIKED 且状态保持一致
    if (rec.status === 'UNLIKED') {
      setStatus('未点赞（已取消计数）', '#f5a623');
      return;
    }

    // 检查是否真正播放
    if (!isPlaying(v)) {
      setStatus('等待播放…', '#f5a623');
      return;
    }

    // 状态流转：开始播放
    rec.status = 'PLAYING';

    // 如果滑到该视频时本身就已经处于点赞状态 -> 标记为 SKIPPED
    if (currentlyLiked) {
      rec.status = 'SKIPPED';
      saveRecords();
      setStatus('已点赞，跳过', '#999');
      return;
    }

    // 未点赞 -> 派发点赞动作，进入 LIKED 状态
    fireZ();
    rec.status = 'LIKED';
    rec.actionTime = Date.now();
    saveRecords();

    setStatus('已点赞 ' + getLikedCount() + ' 个', '#fe2c55');
  }

  /* ============ 悬浮面板 UI ============ */
  GM_addStyle(`
    #dy-panel{position:fixed;right:20px;bottom:20px;z-index:999999;width:224px;
      border-radius:16px;background:rgba(20,20,22,.92);color:#fff;
      font:13px/1.6 -apple-system,"PingFang SC",sans-serif;
      box-shadow:0 8px 28px rgba(0,0,0,.35);user-select:none;overflow:hidden;
      transition:width .15s ease,border-radius .15s ease;}
    #dy-panel.collapsed{width:auto;border-radius:999px;}
    #dy-panel.collapsed #dy-body{display:none;}
    #dy-panel.collapsed #dy-close{display:none;}
    #dy-header{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;}
    #dy-dot{width:10px;height:10px;border-radius:50%;flex:none;background:#2ecc71;}
    #dy-title{font-weight:600;flex:1;white-space:nowrap;overflow:hidden;}
    #dy-body{padding:0 12px 12px;}
    #dy-status{font-size:12px;color:#fe2c55;margin-bottom:10px;}
    .dy-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
    .dy-hint{font-size:11px;opacity:.5;}
    .dy-switch{position:relative;display:inline-block;width:44px;height:26px;flex:none;}
    .dy-switch input{opacity:0;width:0;height:0;}
    .dy-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#5a5a5e;border-radius:26px;transition:.2s;}
    .dy-slider::before{content:"";position:absolute;height:22px;width:22px;left:2px;bottom:2px;background:#fff;border-radius:50%;transition:.2s;}
    .dy-switch input:checked + .dy-slider{background:#fe2c55;}
    .dy-switch input:checked + .dy-slider::before{transform:translateX(18px);}
    #dy-close,#dy-collapse{cursor:pointer;opacity:.7;padding:0 2px;flex:none;}
    #dy-close:hover,#dy-collapse:hover{opacity:1;}
  `);

  const panel = document.createElement('div');
  panel.id = 'dy-panel';
  panel.innerHTML =
    '<div id="dy-header">' +
    '<span id="dy-dot"></span>' +
    '<span id="dy-title">抖音自动点赞</span>' +
    '<span id="dy-collapse">▾</span>' +
    '<span id="dy-close">✕</span>' +
    '</div>' +
    '<div id="dy-body">' +
    '<div id="dy-status">运行中…</div>' +
    '<div class="dy-row">' +
    '<span>自动点赞</span>' +
    '<label class="dy-switch"><input id="dy-toggle" type="checkbox" checked><span class="dy-slider"></span></label>' +
    '</div>' +
    '<div class="dy-hint">可在油猴菜单中导出今日数据</div>' +
    '</div>';
  document.body.appendChild(panel);

  const $ = (sel) => panel.querySelector(sel);
  const elHeader = $('#dy-header');
  const elDot = $('#dy-dot');
  const elTitle = $('#dy-title');
  const elStatus = $('#dy-status');
  const elCollapse = $('#dy-collapse');
  const elClose = $('#dy-close');
  const elToggle = $('#dy-toggle');

  let collapsed = false;

  function setStatus(text, color) {
    elStatus.textContent = text;
    elStatus.style.color = color;
  }

  function updateRunUI() {
    elDot.style.background = running ? '#2ecc71' : '#ff4d4f';
    elToggle.checked = running;
    elTitle.textContent = collapsed ? (running ? '运行中(' + getLikedCount() + ')' : '已停止') : '抖音自动点赞 (' + getLikedCount() + ')';
  }

  function setCollapsed(v) {
    collapsed = v;
    panel.classList.toggle('collapsed', v);
    elCollapse.textContent = v ? '▸' : '▾';
    updateRunUI();
  }

  elCollapse.addEventListener('click', () => setCollapsed(!collapsed));
  elClose.addEventListener('click', () => panel.remove());
  elToggle.addEventListener('change', () => {
    running = elToggle.checked;
    updateRunUI();
    if (running) tick();
  });

  // 拖动面板
  let drag = null;
  elHeader.addEventListener('mousedown', (e) => {
    if (e.target.closest('#dy-close') || e.target.closest('#dy-collapse')) return;
    const rect = panel.getBoundingClientRect();
    drag = { sx: e.clientX, sy: e.clientY, l: rect.left, t: rect.top };
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    panel.style.left = (drag.l + e.clientX - drag.sx) + 'px';
    panel.style.top = (drag.t + e.clientY - drag.sy) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => { drag = null; });

  // 循环触发
  setInterval(() => {
    tick();
    updateRunUI();
  }, CFG.pollMs);

  document.addEventListener('play', () => {
    tick();
    updateRunUI();
  }, true);

  updateRunUI();
  tick();
})();