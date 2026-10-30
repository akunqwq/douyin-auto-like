// ==UserScript==
// @name         抖音自动点赞
// @version      1.9.0
// @description  视频开始播放时通过 Z 键通道自动点赞，跟踪点赞状态与手动取消。
// @author       阿鲲
// @match        https://www.douyin.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'dy_auto_like_data';

  const ACTIVE_SELECTOR =
    '[data-e2e="feed-active-video"][data-e2e-vid]';

  const CANONICAL_SELECTOR =
    '#sliderVideo[data-e2e="feed-active-video"][data-e2e-vid]';

  const LIKE_SELECTOR =
    '[data-e2e="video-player-digg"], [data-e2e="feed-digg"]';

  /* ==================== 全局状态 ==================== */

  let running = true;
  let destroyed = false;
  let observer = null;
  let frame = 0;
  let session = null;
  let collapsed = false;
  let drag = null;
  let manualAction = null;

  // 本次运行中已经触发过 Z 的视频 ID。
  const triggeredIds = new Set();

  // 本次运行中自动点赞成功且尚未手动取消的视频。
  const likedIds = new Set();

  // 已经绑定播放事件的视频元素。
  const videoListeners = new Map();

  /* ==================== 每日记录 ==================== */

  const date = new Date();

  const today = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');

  const saved = GM_getValue(STORAGE_KEY, null);
  const records = Object.create(null);

  if (
    saved?.date === today &&
    saved.records &&
    typeof saved.records === 'object'
  ) {
    for (const id of Object.keys(saved.records)) {
      if (/^\d+$/.test(id)) {
        records[id] = true;
      }
    }
  }

  function getCount() {
    return Object.keys(records).length;
  }

  function saveRecords() {
    if (destroyed) return;

    GM_setValue(STORAGE_KEY, {
      date: today,
      records
    });
  }

  function recordVideo(id) {
    if (records[id]) return;

    records[id] = true;
    saveRecords();
    updateUI();
  }

  GM_registerMenuCommand('导出今日视频 ID (JSON)', () => {
    const ids = Object.keys(records);
    const a = document.createElement('a');

    a.href = 'data:application/json;charset=utf-8,' +
      encodeURIComponent(JSON.stringify({
        date: today,
        total: ids.length,
        ids
      }, null, 2));

    a.download = `douyin_video_ids_${today}.json`;

    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  /* ==================== 悬浮面板 ==================== */

  GM_addStyle(`
    #dy-panel {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 999999;
      width: 240px;
      border-radius: 14px;
      background: rgba(20,20,22,.94);
      color: #fff;
      font: 13px/1.6 -apple-system,"PingFang SC",sans-serif;
      box-shadow: 0 8px 28px rgba(0,0,0,.35);
      user-select: none;
      overflow: hidden;
    }

    #dy-panel.collapsed {
      width: auto;
      border-radius: 999px;
    }

    #dy-panel.collapsed #dy-body,
    #dy-panel.collapsed #dy-close {
      display: none;
    }

    #dy-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      cursor: move;
    }

    #dy-dot {
      width: 9px;
      height: 9px;
      flex: none;
      border-radius: 50%;
    }

    #dy-title {
      flex: 1;
      overflow: hidden;
      white-space: nowrap;
    }

    #dy-body {
      padding: 0 12px 12px;
    }

    #dy-status {
      font-size: 12px;
      margin-bottom: 6px;
      overflow-wrap: anywhere;
    }

    #dy-video {
      font-size: 11px;
      opacity: .75;
      overflow-wrap: anywhere;
      margin-bottom: 8px;
    }

    #dy-count {
      font-size: 11px;
      opacity: .75;
      margin-bottom: 10px;
    }

    .dy-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .dy-switch {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 26px;
    }

    .dy-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .dy-slider {
      position: absolute;
      inset: 0;
      cursor: pointer;
      border-radius: 26px;
      background: #5a5a5e;
    }

    .dy-slider:before {
      content: "";
      position: absolute;
      left: 2px;
      bottom: 2px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #fff;
      transition: .2s;
    }

    .dy-switch input:checked + .dy-slider {
      background: #fe2c55;
    }

    .dy-switch input:checked + .dy-slider:before {
      transform: translateX(18px);
    }

    #dy-close,
    #dy-collapse {
      cursor: pointer;
      opacity: .7;
    }
  `);

  const panel = document.createElement('div');

  panel.id = 'dy-panel';

  panel.innerHTML = `
    <div id="dy-header">
      <span id="dy-dot"></span>
      <span id="dy-title">抖音自动点赞</span>
      <span id="dy-collapse">▾</span>
      <span id="dy-close">✕</span>
    </div>

    <div id="dy-body">
      <div id="dy-status">正在初始化…</div>
      <div id="dy-video">当前视频 ID：未就绪</div>
      <div id="dy-count"></div>

      <div class="dy-row">
        <span>自动点赞</span>
        <label class="dy-switch">
          <input id="dy-toggle" type="checkbox" checked>
          <span class="dy-slider"></span>
        </label>
      </div>
    </div>
  `;

  document.body.appendChild(panel);

  const $ = selector => panel.querySelector(selector);

  const statusEl = $('#dy-status');
  const videoIdEl = $('#dy-video');
  const countEl = $('#dy-count');
  const titleEl = $('#dy-title');
  const dotEl = $('#dy-dot');
  const toggleEl = $('#dy-toggle');
  const collapseEl = $('#dy-collapse');

  let lastStatus = '';
  let lastColor = '';

  function setStatus(message, color = '#f5a623') {
    if (destroyed) return;

    if (message === lastStatus && color === lastColor) {
      return;
    }

    lastStatus = message;
    lastColor = color;

    statusEl.textContent = message;
    statusEl.style.color = color;
  }

  function updateUI() {
    if (destroyed) return;

    dotEl.style.background = running
      ? '#2ecc71'
      : '#ff4d4f';

    toggleEl.checked = running;

    titleEl.textContent = collapsed
      ? (running ? '运行中' : '已停止')
      : '抖音自动点赞';

    countEl.textContent =
      `今日识别视频：${getCount()} 条 · 本次有效点赞：${likedIds.size} 次`;
  }

  /* ==================== 视频基础识别 ==================== */

  function isPlaying(video) {
    return (
      !video.paused &&
      !video.ended &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    );
  }

  function isVisibleVideo(video) {
    const rect = video.getBoundingClientRect();
    const style = getComputedStyle(video);

    return (
      rect.width >= 100 &&
      rect.height >= 100 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0'
    );
  }

  function getVideoIdFromAncestors(video) {
    let node = video;

    while (node && node !== document.body) {
      const id = node.getAttribute('data-e2e-vid')?.trim();

      if (id && /^\d+$/.test(id)) {
        return id;
      }

      node = node.parentElement;
    }

    return null;
  }

  /* ==================== 点赞按钮识别 ==================== */

  function findLikeButton(box) {
    if (!box) return null;

    return (
      box.querySelector('[data-e2e="video-player-digg"]') ||
      box.querySelector('[data-e2e="feed-digg"]')
    );
  }

  function getLikeState(button) {
    if (!button) return 'UNKNOWN';

    const state = button.getAttribute('data-e2e-state');

    if (state === 'video-player-is-digged') {
      return 'LIKED';
    }

    if (state === 'video-player-no-digged') {
      return 'UNLIKED';
    }

    return 'UNKNOWN';
  }

  /*
   * 从 video 元素向上寻找包含该视频及点赞按钮的容器。
   * 优先官方活动容器，其他页面则寻找最近的单视频容器。
   */

  function getVideoContext(video, fallbackId = null) {
    const officialBox = video.closest(ACTIVE_SELECTOR);

    let box = officialBox;
    let likeButton = officialBox
      ? findLikeButton(officialBox)
      : null;

    if (!likeButton) {
      let node = video.parentElement;

      while (node && node !== document.body) {
        const videos = node.querySelectorAll('video');

        if (videos.length === 1) {
          const button = findLikeButton(node);

          if (button) {
            box = node;
            likeButton = button;
            break;
          }

          if (!box) {
            box = node;
          }
        }

        node = node.parentElement;
      }
    }

    const id =
      getVideoIdFromAncestors(video) ||
      fallbackId;

    if (!id || !/^\d+$/.test(id)) {
      return null;
    }

    if (!box) {
      box = video.parentElement;
    }

    return {
      id,
      box,
      video,
      likeButton
    };
  }

  /* ==================== 多页面当前视频识别 ==================== */

  function getVisibleVideoCandidates(root = document) {
    return Array.from(root.querySelectorAll('video'))
      .filter(isVisibleVideo);
  }

  function chooseMainVideo(videos) {
    if (!videos.length) return null;

    const candidates = videos.map(video => {
      const rect = video.getBoundingClientRect();

      return {
        video,
        area: rect.width * rect.height,
        playing: isPlaying(video)
      };
    });

    // 优先当前正在播放的视频。
    const playing = candidates.filter(item => item.playing);

    const pool = playing.length
      ? playing
      : candidates;

    pool.sort((a, b) => b.area - a.area);

    return pool[0]?.video || null;
  }

  function getCurrentVideo() {
    /* 1. 原有标准播放器 */

    const canonical = document.querySelector(
      CANONICAL_SELECTOR
    );

    if (canonical) {
      const video = canonical.querySelector('video');

      if (video) {
        const ctx = getVideoContext(video);

        if (ctx) return ctx;
      }
    }

    /* 2. 官方活动视频容器 */

    const activeBoxes = Array.from(
      document.querySelectorAll(ACTIVE_SELECTOR)
    );

    if (activeBoxes.length) {
      const activeVideos = activeBoxes
        .map(box => box.querySelector('video'))
        .filter(Boolean);

      const selected = chooseMainVideo(activeVideos);

      if (selected) {
        const ctx = getVideoContext(selected);

        if (ctx) return ctx;
      }
    }

    /* 3. 精选页及其他带 modal_id 的播放弹层 */

    const modalId = new URL(location.href)
      .searchParams
      .get('modal_id');

    if (modalId && /^\d+$/.test(modalId)) {
      const exactNode = Array.from(
        document.querySelectorAll('[data-e2e-vid]')
      ).find(node => {
        return node.getAttribute('data-e2e-vid') === modalId;
      });

      if (exactNode) {
        const video = exactNode.matches('video')
          ? exactNode
          : exactNode.querySelector('video');

        if (video) {
          const ctx = getVideoContext(video, modalId);

          if (ctx) return ctx;
        }
      }

      // 未找到直接 ID 节点时，优先寻找弹层中的主视频。
      const dialogs = Array.from(
        document.querySelectorAll('[role="dialog"]')
      ).filter(dialog => {
        const rect = dialog.getBoundingClientRect();

        return rect.width >= 100 && rect.height >= 100;
      });

      for (const dialog of dialogs) {
        const video = chooseMainVideo(
          getVisibleVideoCandidates(dialog)
        );

        if (video) {
          const ctx = getVideoContext(video, modalId);

          if (ctx) return ctx;
        }
      }

      // 没有标准 dialog 时，尝试当前页面最大的播放视频。
      const modalVideo = chooseMainVideo(
        getVisibleVideoCandidates()
      );

      if (modalVideo) {
        const ctx = getVideoContext(modalVideo, modalId);

        if (ctx) return ctx;
      }
    }

    /* 4. 搜索结果播放页及其他非标准播放器 */

    const videos = getVisibleVideoCandidates();

    const identifiedVideos = videos.filter(video => {
      return getVideoIdFromAncestors(video);
    });

    const selected = chooseMainVideo(identifiedVideos);

    if (selected) {
      return getVideoContext(selected);
    }

    return null;
  }

  /* ==================== Z 键通道 ==================== */

  function pressZ() {
    const options = {
      key: 'z',
      code: 'KeyZ',
      keyCode: 90,
      which: 90,
      bubbles: true,
      cancelable: true
    };

    document.dispatchEvent(
      new KeyboardEvent('keydown', options)
    );

    document.dispatchEvent(
      new KeyboardEvent('keyup', options)
    );
  }

  /* ==================== 播放事件监听 ==================== */

  function attachVideoEvents(video) {
    if (videoListeners.has(video)) return;

    const handlers = new Map();

    for (const name of [
      'playing',
      'play',
      'pause',
      'waiting',
      'stalled',
      'ended',
      'canplay',
      'loadeddata'
    ]) {
      const handler = () => process();

      handlers.set(name, handler);
      video.addEventListener(name, handler);
    }

    videoListeners.set(video, handlers);
  }

  /* ==================== 视频会话 ==================== */

  function createSession(id) {
    session = {
      id,
      triggered: triggeredIds.has(id),
      cancelled: false,
      autoLikeRequested: false,
      autoLiked: false
    };

    manualAction = null;

    recordVideo(id);

    if (session.triggered) {
      setStatus(`视频 ${id}：本次运行已处理`, '#999');
    } else {
      setStatus(`视频 ${id}：等待开始播放…`);
    }
  }

  /* ==================== 核心处理 ==================== */

  function process() {
    if (destroyed) return;

    if (!running) {
      setStatus('自动点赞已停止', '#999');
      return;
    }

    if (document.hidden) return;

    const ctx = getCurrentVideo();

    if (!ctx) {
      videoIdEl.textContent = '当前视频 ID：未就绪';
      setStatus('等待识别当前播放视频…');
      return;
    }

    const { id, video, likeButton } = ctx;

    videoIdEl.textContent = `当前官方视频 ID：${id}`;

    // ID 变化才创建新任务。
    if (!session || session.id !== id) {
      createSession(id);
    }

    attachVideoEvents(video);

    // 用户手动取消之后，不再干预当前视频。
    if (session.cancelled) {
      return;
    }

    // 本视频已经发送过 Z，不重复发送。
    if (session.triggered) {
      return;
    }

    // 暂停、缓冲、未开始播放时不执行。
    if (!isPlaying(video)) {
      setStatus(
        video.paused
          ? `视频 ${id}：已暂停，等待恢复播放`
          : `视频 ${id}：等待开始播放…`
      );

      return;
    }

    // 等待当前视频的点赞按钮及状态加载。
    const state = getLikeState(likeButton);

    if (state === 'UNKNOWN') {
      setStatus(`视频 ${id}：等待点赞按钮状态就绪…`);
      return;
    }

    // 已经点赞，不再发送 Z，防止反向取消。
    if (state === 'LIKED') {
      session.triggered = true;
      triggeredIds.add(id);

      setStatus(`视频 ${id}：已经点赞，跳过`, '#fe2c55');
      return;
    }

    // 未点赞：当前视频只触发一次 Z。
    session.triggered = true;
    session.autoLikeRequested = true;

    triggeredIds.add(id);

    try {
      pressZ();

      setStatus(
        `视频 ${id}：已发送 Z 键事件，监测点赞状态`,
        '#fe2c55'
      );
    } catch {
      session.autoLikeRequested = false;

      setStatus(
        `视频 ${id}：Z 键事件发送失败`,
        '#ff7875'
      );
    }
  }

  /* ==================== DOM 调度 ==================== */

  function scheduleProcess() {
    if (destroyed || frame) return;

    frame = requestAnimationFrame(() => {
      frame = 0;
      process();
    });
  }

  function isPanelNode(node) {
    return Boolean(
      node &&
      (node === panel || panel.contains(node))
    );
  }

  /* ==================== 用户手动取消识别 ==================== */

  function markManualAction(event) {
    if (!running || !event.isTrusted || !session) {
      return;
    }

    const ctx = getCurrentVideo();

    if (!ctx || ctx.id !== session.id) {
      return;
    }

    const button = ctx.likeButton;

    if (!button || getLikeState(button) !== 'LIKED') {
      return;
    }

    if (event.type === 'keydown') {
      const target = event.target;

      if (
        target instanceof Element &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return;
      }

      const key = event.key.toLowerCase();

      const isZ = key === 'z';
      const isButtonKey =
        (key === 'enter' || key === ' ') &&
        (
          document.activeElement === button ||
          button.contains(document.activeElement)
        );

      if (!isZ && !isButtonKey) {
        return;
      }

      if (event.repeat) return;
    } else {
      const target = event.target;

      if (!(target instanceof Element)) return;

      if (target.closest(LIKE_SELECTOR) !== button) {
        return;
      }
    }

    manualAction = {
      id: ctx.id,
      button,
      time: performance.now()
    };
  }

  document.addEventListener(
    'pointerdown',
    markManualAction,
    true
  );

  document.addEventListener(
    'keydown',
    markManualAction,
    true
  );

  /* ==================== 点赞状态监听 ==================== */

  function handleLikeMutation(mutation, target) {
    if (!running || !session) return;

    const oldState = mutation.oldValue;
    const newState = target.getAttribute('data-e2e-state');

    const ctx = getCurrentVideo();

    if (
      !ctx ||
      ctx.id !== session.id ||
      ctx.likeButton !== target
    ) {
      return;
    }

    // 自动点赞成功。
    if (
      oldState === 'video-player-no-digged' &&
      newState === 'video-player-is-digged' &&
      session.autoLikeRequested
    ) {
      session.autoLikeRequested = false;
      session.autoLiked = true;

      likedIds.add(ctx.id);

      setStatus(`视频 ${ctx.id}：已点赞`, '#fe2c55');
      updateUI();

      return;
    }

    // 用户主动取消点赞。
    if (
      oldState === 'video-player-is-digged' &&
      newState === 'video-player-no-digged' &&
      session.autoLiked &&
      manualAction &&
      manualAction.id === ctx.id &&
      manualAction.button === target &&
      performance.now() - manualAction.time < 2000
    ) {
      session.cancelled = true;
      session.autoLiked = false;

      likedIds.delete(ctx.id);
      manualAction = null;

      setStatus(
        `视频 ${ctx.id}：检测到手动取消点赞`,
        '#999'
      );

      updateUI();
    }
  }

  /* ==================== MutationObserver ==================== */

  observer = new MutationObserver(mutations => {
    if (destroyed) return;

    let shouldProcess = false;

    for (const mutation of mutations) {
      const target = mutation.target.nodeType === 1
        ? mutation.target
        : mutation.target.parentElement;

      if (!target || isPanelNode(target)) {
        continue;
      }

      if (
        mutation.type === 'attributes' &&
        mutation.attributeName === 'data-e2e-state' &&
        target.matches(LIKE_SELECTOR)
      ) {
        handleLikeMutation(mutation, target);
        shouldProcess = true;
      }

      if (
        mutation.type === 'attributes' &&
        (
          mutation.attributeName === 'data-e2e-vid' ||
          mutation.attributeName === 'data-e2e'
        )
      ) {
        shouldProcess = true;
      }

      if (mutation.type === 'childList') {
        shouldProcess = true;
      }
    }

    if (shouldProcess) {
      scheduleProcess();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [
      'data-e2e',
      'data-e2e-state',
      'data-e2e-vid'
    ]
  });

  /* ==================== SPA 路由变化 ==================== */

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  function onRouteChange() {
    manualAction = null;
    scheduleProcess();
  }

  function wrappedPushState(...args) {
    const result = originalPushState.apply(this, args);

    onRouteChange();

    return result;
  }

  function wrappedReplaceState(...args) {
    const result = originalReplaceState.apply(this, args);

    onRouteChange();

    return result;
  }

  history.pushState = wrappedPushState;
  history.replaceState = wrappedReplaceState;

  window.addEventListener('popstate', onRouteChange);

  /* ==================== 页面可见性 ==================== */

  function onVisibilityChange() {
    if (!document.hidden) {
      process();
    }
  }

  document.addEventListener(
    'visibilitychange',
    onVisibilityChange
  );

  /* ==================== 面板交互 ==================== */

  function onToggle() {
    running = toggleEl.checked;

    updateUI();
    process();
  }

  function onCollapse() {
    collapsed = !collapsed;

    panel.classList.toggle('collapsed', collapsed);
    collapseEl.textContent = collapsed ? '▸' : '▾';

    updateUI();
  }

  function onMouseDown(event) {
    if (event.target.closest('#dy-close, #dy-collapse')) {
      return;
    }

    const rect = panel.getBoundingClientRect();

    drag = {
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top
    };

    event.preventDefault();
  }

  function onMouseMove(event) {
    if (!drag || destroyed) return;

    panel.style.left =
      `${drag.left + event.clientX - drag.x}px`;

    panel.style.top =
      `${drag.top + event.clientY - drag.y}px`;

    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function onMouseUp() {
    drag = null;
  }

  /* ==================== 清理 ==================== */

  function destroy() {
    if (destroyed) return;

    destroyed = true;

    observer?.disconnect();

    if (frame) {
      cancelAnimationFrame(frame);
    }

    for (const [video, handlers] of videoListeners) {
      for (const [name, handler] of handlers) {
        video.removeEventListener(name, handler);
      }
    }

    videoListeners.clear();

    if (history.pushState === wrappedPushState) {
      history.pushState = originalPushState;
    }

    if (history.replaceState === wrappedReplaceState) {
      history.replaceState = originalReplaceState;
    }

    window.removeEventListener('popstate', onRouteChange);

    document.removeEventListener(
      'visibilitychange',
      onVisibilityChange
    );

    document.removeEventListener(
      'pointerdown',
      markManualAction,
      true
    );

    document.removeEventListener(
      'keydown',
      markManualAction,
      true
    );

    toggleEl.removeEventListener('change', onToggle);
    collapseEl.removeEventListener('click', onCollapse);

    $('#dy-close').removeEventListener('click', destroy);
    $('#dy-header').removeEventListener('mousedown', onMouseDown);

    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    panel.remove();
  }

  toggleEl.addEventListener('change', onToggle);
  collapseEl.addEventListener('click', onCollapse);

  $('#dy-close').addEventListener('click', destroy);
  $('#dy-header').addEventListener('mousedown', onMouseDown);

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  /* ==================== 启动 ==================== */

  saveRecords();
  updateUI();
  process();


})();