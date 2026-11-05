// ==UserScript==
// @name         抖音自动点赞
// @version      2.3.2
// @description  视频播放后延迟点赞（默认 10 秒，不足 10 秒的短视频降至 3 秒），通过 Z 键通道自动点赞，跟踪点赞状态与手动取消。
// @author       阿鲲
// @match        https://www.douyin.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";


  const STORAGE_KEY = "dy_auto_like_data"; // 存储键值
  const ACTIVE_SELECTOR = '[data-e2e="feed-active-video"][data-e2e-vid]'; // 激活视频选择器
  const PLAYER_DIGG_SELECTOR = '[data-e2e="video-player-digg"]'; // 播放器点赞选择器
  const FEED_DIGG_SELECTOR = '[data-e2e="feed-digg"]'; // 视频卡片点赞选择器
  const LIKE_SELECTOR = `${PLAYER_DIGG_SELECTOR}, ${FEED_DIGG_SELECTOR}`; // 点赞选择器

  // 点赞状态
  const STATE_LIKED = "video-player-is-digged";
  const STATE_UNLIKED = "video-player-no-digged";

  // 视频ID正则
  const VID_PATTERN = /^\d+$/;

  // 视频或弹层小于该尺寸视为预览。
  const MIN_VISIBLE_SIZE = 100;

  // 区分"当前播放视频" 和 "预览视频"
  const CONTROL_SELECTOR = '[data-e2e="video-play-more"]';

  // 自动点赞延迟，单位毫秒。
  const LIKE_DELAY = 10_000; // 数字分隔符（ES2021 引入的语法）

  // 短视频（时长不足 LIKE_DELAY）的点赞延迟。默认阈值 10s 对短
  // 视频意味着"播完也没点到"，降至 3s 让点赞有机会生效。
  const LIKE_DELAY_SHORT = 3_000;

  let running = true;
  let structureObserver = null;
  let stateObserver = null;
  let frame = 0;
  let session = null;
  // 默认收起为悬浮入口，完整面板由入口长按展开。
  let collapsed = true;
  let manualAction = null;

  // 已触发点赞的视频ID
  const triggeredIds = new Set();
  const likedIds = new Set();
  const videoListeners = new Map();

  // 格式化日期
  function formatDate(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  let today = formatDate(new Date());
  // 当前日期，跨日时清空记录
  function rolloverIfNeeded() {
    const now = formatDate(new Date());
    if (now === today) return;
    today = now;
    for (const id of Object.keys(records)) {
      delete records[id];
    }
  }

  // 持久化记录
  const records = Object.create(null);

  // 获取记录数量
  function getCount() {
    return Object.keys(records).length;
  }

  // 保存记录
  function saveRecords() {
    rolloverIfNeeded();
    GM_setValue(STORAGE_KEY, {
      date: today,
      records,
    });
  }

  // 读取记录
  function recordVideo(id) {
    rolloverIfNeeded();
    if (records[id]) return;
    records[id] = true;
    saveRecords();
    updateUI();
  }

  // 导出刷视频数据 (JSON)
  GM_registerMenuCommand("导出今日刷视频数据", () => {
    rolloverIfNeeded();

    const ids = Object.keys(records);
    const a = document.createElement("a");

    a.href =
      "data:application/json;charset=utf-8," +
      encodeURIComponent(
        JSON.stringify(
          {
            date: today,
            total: ids.length,
            ids,
          },
          null,
          2,
        ),
      );

    a.download = `douyin_video_ids_${today}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  /* ==================== UI样式 ==================== */

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

    #dy-close {
      cursor: pointer;
      opacity: .7;
    }
  `);

  const panel = document.createElement("div");
  panel.id = "dy-panel";
  panel.innerHTML = `
    <div id="dy-header">
      <span id="dy-dot"></span>
      <span id="dy-title">抖音自动点赞</span>
      <span id="dy-close">✕</span>
    </div>

    <div id="dy-body">
      <div id="dy-status">就绪</div>
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

  // 初始即为悬浮入口形态。
  panel.classList.add("collapsed");

  const $ = (selector) => panel.querySelector(selector);
  const statusEl = $("#dy-status");
  const videoIdEl = $("#dy-video");
  const countEl = $("#dy-count");
  const titleEl = $("#dy-title");
  const dotEl = $("#dy-dot");
  const toggleEl = $("#dy-toggle");

  let lastStatus = "";
  let lastColor = "";

  function setStatus(message, color = "#f5a623") {
    if (message === lastStatus && color === lastColor) {
      return;
    }

    lastStatus = message;
    lastColor = color;

    statusEl.textContent = message;
    statusEl.style.color = color;
  }

  function updateUI() {
    dotEl.style.background = running ? "#2ecc71" : "#ff4d4f";

    toggleEl.checked = running;

    titleEl.textContent = collapsed
      ? running
        ? "运行中"
        : "暂停中"
      : "自动点赞脚本";

    countEl.textContent = `今日累计刷视频${getCount()}`;
  }

  /* ==================== 视频状态监测 ==================== */

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
      rect.width >= MIN_VISIBLE_SIZE &&
      rect.height >= MIN_VISIBLE_SIZE &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function getVideoIdFromAncestors(video) {
    let node = video;

    while (node && node !== document.body) {
      const id = node.getAttribute("data-e2e-vid")?.trim();

      if (id && VID_PATTERN.test(id)) {
        return id;
      }
      node = node.parentElement;
    }

    return null;
  }

  function findLikeButton(box) {
    if (!box) return null;
    return (
      box.querySelector(PLAYER_DIGG_SELECTOR) ||
      box.querySelector(FEED_DIGG_SELECTOR)
    );
  }

  function getLikeState(button) {
    if (!button) return "UNKNOWN";
    const state = button.getAttribute("data-e2e-state");
    if (state === STATE_LIKED) {
      return "LIKED";
    }
    if (state === STATE_UNLIKED) {
      return "UNLIKED";
    }

    return "UNKNOWN";
  }

  // 识别视频上下文
  function getVideoContext(video, requireControls = false) {
    let container = video.closest(ACTIVE_SELECTOR);
    let likeButton = findLikeButton(container);

    if (!likeButton) {
      let node = video.parentElement;

      while (node && node !== document.body) {
        if (node.querySelectorAll("video").length === 1) {
          const button = findLikeButton(node);

          if (button) {
            container = node;
            likeButton = button;
            break;
          }
        }

        node = node.parentElement;
      }
    }

    const id = getVideoIdFromAncestors(video);

    if (!id || !VID_PATTERN.test(id)) {
      return null;
    }

    if (requireControls && !container?.querySelector(CONTROL_SELECTOR)) {
      return null;
    }

    return {
      id,
      video,
      likeButton,
    };
  }

  function getVisibleVideoCandidates(root = document) {
    return Array.from(root.querySelectorAll("video")).filter(isVisibleVideo);
  }

  // 对候选视频进行筛选，排除缺少必要身份及操作控件的预览视频；
  // 多个有效候选共存时，按播放状态和可见区域面积进行排序。
  // 优先选择正在播放的视频，同状态下按可见区域面积降序选择。
  function rankVideos(videos) {
    return videos
      .map((video) => {
        const rect = video.getBoundingClientRect();

        return {
          video,
          area: rect.width * rect.height,
          playing: isPlaying(video),
        };
      })
      .sort((a, b) => b.playing - a.playing || b.area - a.area)
      .map((item) => item.video);
  }

  function chooseMainVideo(videos) {
    return rankVideos(videos)[0] || null;
  }

  function resolvePlatformMarkedVideo() {
    const videos = Array.from(document.querySelectorAll(ACTIVE_SELECTOR))
      .map((box) => box.querySelector("video"))
      .filter(Boolean);

    const selected = chooseMainVideo(videos);

    return selected ? getVideoContext(selected) : null;
  }

  function resolveUrlMatchedVideo() {
    const modalId = getModalId();

    if (!modalId) return null;
    const exactNode = Array.from(
      document.querySelectorAll("[data-e2e-vid]"),
    ).find((node) => node.getAttribute("data-e2e-vid") === modalId);

    if (exactNode) {
      const video = exactNode.matches("video")
        ? exactNode
        : exactNode.querySelector("video");

      const ctx = video ? getVideoContext(video) : null;

      if (ctx) return ctx;
    }

    for (const dialog of getVisibleDialogs()) {
      const video = chooseMainVideo(getVisibleVideoCandidates(dialog));
      const ctx = video ? getVideoContext(video) : null;
      if (ctx && ctx.id === modalId) return ctx;
    }

    return null;
  }

  function getModalId() {
    const id = new URL(location.href).searchParams.get("modal_id");

    return id && VID_PATTERN.test(id) ? id : null;
  }

  function getVisibleDialogs() {
    return Array.from(document.querySelectorAll('[role="dialog"]')).filter(
      (dialog) => {
        const rect = dialog.getBoundingClientRect();

        return (
          rect.width >= MIN_VISIBLE_SIZE && rect.height >= MIN_VISIBLE_SIZE
        );
      },
    );
  }

  // 启发式：弹层内的主视频，身份以视频自身为准。
  function resolveHeuristicVideo() {
    for (const video of rankVideos(getVisibleVideoCandidates())) {
      const ctx = getVideoContext(video, true);

      if (ctx) return ctx;
    }

    return null;
  }

  const VIDEO_RESOLVERS = [
    resolvePlatformMarkedVideo,
    resolveUrlMatchedVideo,
    resolveHeuristicVideo,
  ];

  function getCurrentVideo() {
    for (const resolve of VIDEO_RESOLVERS) {
      const ctx = resolve();

      if (ctx) return ctx;
    }

    return null;
  }

  /* ==================== Z 键通道与播放事件 ==================== */

  function pressZ() {
    const options = {
      key: "z",
      code: "KeyZ",
      keyCode: 90,
      which: 90,
      bubbles: true,
      cancelable: true,
    };

    document.dispatchEvent(new KeyboardEvent("keydown", options));

    document.dispatchEvent(new KeyboardEvent("keyup", options));
  }

  // 需要触发重新处理的播放相关事件。
  const VIDEO_EVENTS = [
    "playing",
    "play",
    "pause",
    "waiting",
    "stalled",
    "ended",
    "canplay",
    "loadeddata",
  ];

  function attachVideoEvents(video) {
    if (videoListeners.has(video)) return;
    const handler = () => process();
    for (const name of VIDEO_EVENTS) {
      video.addEventListener(name, handler);
    }
    videoListeners.set(video, handler);
  }

  /* ==================== 视频会话 ==================== */

  function createSession(id) {
    if (session?.pendingTimer) {
      clearTimeout(session.pendingTimer);
    }

    session = {
      id,
      triggered: triggeredIds.has(id),
      cancelled: false,
      autoLikeRequested: false,
      autoLiked: false,
      pendingTimer: null,
      // 后台冻结时计时器被清空，剩余毫秒记在这里，回前台续跑。
      frozenRemaining: null,
    };

    manualAction = null;

    recordVideo(id);
  }

  function fireAutoLike(id) {
    if (!session || session.id !== id) return;

    session.pendingTimer = null;

    if (!running || session.cancelled || session.triggered) {
      return;
    }

    const ctx = getCurrentVideo();

    if (!ctx || ctx.id !== id || !isPlaying(ctx.video)) {
      return;
    }

    if (getLikeState(ctx.likeButton) !== "UNLIKED") {
      return;
    }

    session.triggered = true;
    session.autoLikeRequested = true;

    triggeredIds.add(id);

    pressZ();

    setStatus(`视频 ${id}：已发送 Z，监测点赞结果`, "#fe2c55");
  }

  /* ==================== 核心处理 ==================== */

  function process() {
    if (!running) {
      setStatus("自动点赞已停止", "#999");
      return;
    }

    if (document.hidden) return;

    const ctx = getCurrentVideo();

    if (!ctx) return;

    const { id, video, likeButton } = ctx;

    videoIdEl.textContent = `当前官方视频 ID：${id}`;

    // ID 变化才创建新任务。
    if (!session || session.id !== id) {
      createSession(id);
    }

    attachVideoEvents(video);

    // 人工取消后不再自动点赞。
    if (session.cancelled) {
      return;
    }

    // 已触发过，不再重复触发。
    if (session.triggered) {
      return;
    }

    // 延迟点赞，给用户留出判断时间。
    // 计时器存活或处于后台冻结态时都不重新排程。
    if (session.pendingTimer || session.frozenRemaining) {
      return;
    }

    // 暂停、缓冲、未开始播放时不执行。
    if (!isPlaying(video)) return;

    // 等待当前视频的点赞按钮及状态加载。
    const state = getLikeState(likeButton);

    if (state === "UNKNOWN") return;

    // 已点赞，跳过。
    if (state === "LIKED") {
      session.triggered = true;
      triggeredIds.add(id);

      setStatus(`视频 ${id}：已经点赞，跳过`, "#fe2c55");
      return;
    }

    // 未点赞：延迟一段时间后自动点赞，给用户留出判断时间。
    // 视频时长不足默认阈值时降至短视频阈值，否则短视频播完
    // 计时器仍未到点，永远轮不到点赞。
    // duration 为 NaN（元数据未就绪）或 Infinity（直播流）时
    // 比较结果为 false，回落默认阈值，语义自动正确。
    const delay =
      video.duration > 0 && video.duration < LIKE_DELAY / 1000
        ? LIKE_DELAY_SHORT
        : LIKE_DELAY;

    session.pendingUntil = Date.now() + delay;
    session.pendingTimer = setTimeout(() => fireAutoLike(id), delay);

    setStatus(`视频 ${id}：${delay / 1000} 秒后自动点赞`);
  }

  // 调度处理函数，避免重复调度。
  function scheduleProcess() {
    if (frame) return;

    frame = requestAnimationFrame(() => {
      frame = 0;
      process();
    });
  }

  // 判断节点是否在面板内。
  function isPanelNode(node) {
    return Boolean(node && (node === panel || panel.contains(node)));
  }

  /* ==================== 手动取消与点赞状态监听 ==================== */

  function markManualAction(event) {
    if (!running || !event.isTrusted || !session) {
      return;
    }

    const ctx = getCurrentVideo();

    if (!ctx || ctx.id !== session.id) {
      return;
    }

    const button = ctx.likeButton;

    if (!button || getLikeState(button) !== "LIKED") {
      return;
    }

    if (event.type === "keydown") {
      const target = event.target;

      if (
        target instanceof Element &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return;
      }

      const key = event.key.toLowerCase();

      const isZ = key === "z";
      const isButtonKey =
        (key === "enter" || key === " ") &&
        (document.activeElement === button ||
          button.contains(document.activeElement));

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
      time: performance.now(),
    };
  }

  document.addEventListener("pointerdown", markManualAction, true);

  document.addEventListener("keydown", markManualAction, true);

  function handleLikeMutation(mutation, target) {
    if (!running || !session) return;

    const oldState = mutation.oldValue;
    const newState = target.getAttribute("data-e2e-state");

    const ctx = getCurrentVideo();

    if (!ctx || ctx.id !== session.id || ctx.likeButton !== target) {
      return;
    }

    // 自动点赞成功。
    if (
      oldState === STATE_UNLIKED &&
      newState === STATE_LIKED &&
      session.autoLikeRequested
    ) {
      session.autoLikeRequested = false;
      session.autoLiked = true;

      likedIds.add(ctx.id);

      setStatus(`视频 ${ctx.id}：已点赞`, "#fe2c55");
      updateUI();

      return;
    }

    // 用户主动取消点赞。
    if (
      oldState === STATE_LIKED &&
      newState === STATE_UNLIKED &&
      session.autoLiked &&
      manualAction &&
      manualAction.id === ctx.id &&
      manualAction.button === target &&
      performance.now() - manualAction.time < 2000
    ) {
      session.cancelled = true;
      session.autoLiked = false;

      likedIds.delete(ctx.id);

      // 人工否决规则：当前视频停留生效。移出已触发集合，
      // 滑走再滑回视为新观看，允许重新排程点赞。
      triggeredIds.delete(ctx.id);

      manualAction = null;

      setStatus(`视频 ${ctx.id}：检测到手动取消点赞`, "#999");

      updateUI();
    }
  }

  /* ==================== DOM 结构变化监听 ==================== */

  function getMutationTarget(mutation) {
    return mutation.target.nodeType === 1
      ? mutation.target
      : mutation.target.parentElement;
  }

  // 结构变化：视频切换、弹层打开关闭、DOM 节点增删等。
  structureObserver = new MutationObserver((mutations) => {
    if (
      mutations.some((mutation) => !isPanelNode(getMutationTarget(mutation)))
    ) {
      scheduleProcess();
    }
  });

  structureObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  /*
   * 属性变化：点赞状态迁移需要旧值比对，e2e 标记
   * 变化需要重新识别当前视频，二者都依赖
   * attributeOldValue，因此与结构监听分设两个 observer。
   */

  stateObserver = new MutationObserver((mutations) => {
    let shouldProcess = false;

    for (const mutation of mutations) {
      const target = getMutationTarget(mutation);

      if (!target || isPanelNode(target)) {
        continue;
      }

      if (
        mutation.attributeName === "data-e2e-state" &&
        target.matches(LIKE_SELECTOR)
      ) {
        handleLikeMutation(mutation, target);
      }

      shouldProcess = true;
    }

    if (shouldProcess) {
      scheduleProcess();
    }
  });

  stateObserver.observe(document.body, {
    attributes: true,
    subtree: true,
    attributeOldValue: true,
    attributeFilter: ["data-e2e", "data-e2e-state", "data-e2e-vid"],
  });

  /* ==================== 路由与可见性 ==================== */

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

  window.addEventListener("popstate", onRouteChange);

  /*
   * 后台冻结倒计时：标签页隐藏时清掉待触发计时器并记下剩余毫秒，
   * 回前台用剩余时间重排——切后台期间不消耗等待进度，也不点赞。
   */
  function onVisibilityChange() {
    if (document.hidden) {
      if (session?.pendingTimer) {
        clearTimeout(session.pendingTimer);

        session.pendingTimer = null;
        session.frozenRemaining = Math.max(
          0,
          session.pendingUntil - Date.now()
        );
      }

      return;
    }

    if (session?.frozenRemaining) {
      session.pendingUntil = Date.now() + session.frozenRemaining;
      session.pendingTimer = setTimeout(
        () => fireAutoLike(session.id),
        session.frozenRemaining
      );

      session.frozenRemaining = null;
    }

    process();
  }

  document.addEventListener("visibilitychange", onVisibilityChange);

  /* ==================== 面板交互 ==================== */

  function onToggle() {
    running = toggleEl.checked;

    if (!running && session?.pendingTimer) {
      clearTimeout(session.pendingTimer);
      session.pendingTimer = null;
    }

    updateUI();
    process();
  }

  /*
   * 手势状态机：pointerdown 记录坐标并启动 500ms 计时，此后拖拽
   * （位移 > 5px）与长按（静止满 500ms）竞争，只有一个动作胜出：
   * - 拖拽胜出：取消计时器，进入拖拽状态；
   * - 长按胜出：计时器到点，展开完整面板（仅入口态有意义）；
   * - pointerup / pointercancel 提前结束：清理计时器，两个动作都不执行。
   * 悬浮入口靠长按展开，完整面板没有展开按钮（X 只负责收起）。
   */
  const LONG_PRESS_MS = 500;
  const DRAG_THRESHOLD = 5;

  let press = null;

  function resetPress() {
    if (!press) return;

    clearTimeout(press.timer);

    press = null;
  }

  function setCollapsed(value) {
    collapsed = value;

    panel.classList.toggle("collapsed", collapsed);

    updateUI();
  }

  function onHeaderDown(event) {
    if (event.target.closest("#dy-close")) {
      return;
    }

    const rect = panel.getBoundingClientRect();

    press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
      timer: setTimeout(() => {
        // 长按胜出。press 置空后 pointerup 不会再做任何清理。
        press = null;

        if (collapsed) {
          setCollapsed(false);
        }
      }, LONG_PRESS_MS),
    };

    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!press || event.pointerId !== press.pointerId) return;

    if (!press.moved) {
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;

      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

      // 拖拽胜出，长按计时作废。
      press.moved = true;

      clearTimeout(press.timer);
    }

    panel.style.left = `${press.left + event.clientX - press.x}px`;

    panel.style.top = `${press.top + event.clientY - press.y}px`;

    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function onPointerUp(event) {
    if (!press || event.pointerId !== press.pointerId) return;

    // 提前松开：两个动作都不执行。
    resetPress();
  }

  function onPointerCancel(event) {
    if (!press || event.pointerId !== press.pointerId) return;

    // 浏览器接管手势（如触发滚动）：与提前松开同处理。
    resetPress();
  }

  toggleEl.addEventListener("change", onToggle);

  $("#dy-close").addEventListener("click", () => setCollapsed(true));
  $("#dy-header").addEventListener("pointerdown", onHeaderDown);

  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", onPointerCancel);

  /* ==================== 启动 ==================== */

  saveRecords();
  updateUI();
  process();
})();
