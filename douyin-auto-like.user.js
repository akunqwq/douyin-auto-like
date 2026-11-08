// ==UserScript==
// @name         抖音自动点赞
// @version      2.6.7
// @description  按实际播放进度累计后点赞（默认 10 秒，短视频 3 秒），通过快捷键通道实现自动点赞，并跟踪点赞状态与手动操作；附带睡眠定时功能。
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

  const CONFIG = {
    STORAGE_KEY: "dy_auto_like_data",
    platform: {
      activePlayer: '[data-e2e="feed-active-video"][data-e2e-vid]',
      playerDigg: '[data-e2e="video-player-digg"]',
      feedDigg: '[data-e2e="feed-digg"]',
      like: '[data-e2e="video-player-digg"], [data-e2e="feed-digg"]',
      stateLiked: "video-player-is-digged",
      stateUnliked: "video-player-no-digged",
      vidPattern: /^\d+$/,
      videoEvents: ["playing", "play", "pause", "waiting", "stalled", "ended", "canplay", "loadeddata"],
    },
    timing: {
      likeMs: 10_000,
      likeShortMs: 3_000,
      maxStepSec: 1,
      manualActionWindowMs: 2_000,
      playbackTickMs: 1_000,
      longPressMs: 500,
      dragThresholdPx: 5,
    },
  };

  const formatDate = (date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

  const formatRemaining = (ms) => {
    const total = Math.ceil(ms / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  };

  const AppState = {
    running: true,
    collapsed: true,
    session: null,
    manualAction: null,
    triggeredIds: new Set(),
    frame: 0,
    today: formatDate(new Date()),
    records: Object.create(null),
    lastStatus: "",
    lastColor: "",
    press: null,
    // 睡眠定时器状态：增加 remainingMs 动态记录剩余毫秒，支持暂停挂起
    timer: {
      active: false,
      remainingMs: 0,
      tickId: null,
    },
  };

  // 初始化加载本地记录
  {
    const saved = GM_getValue(CONFIG.STORAGE_KEY, null);
    if (saved?.date === AppState.today && saved.records && typeof saved.records === "object") {
      for (const [id, viewed] of Object.entries(saved.records)) {
        if (viewed && CONFIG.platform.vidPattern.test(id)) AppState.records[id] = true;
      }
    }
  }

  const Runtime = {
    controller: new AbortController(),
    observers: [],
    disposers: [],
    boundVideos: new WeakSet(),
    panel: null,
  };

  const on = (target, type, handler, options = {}) => {
    target.addEventListener(type, handler, { ...options, signal: Runtime.controller.signal });
  };

  const observe = (target, options, callback) => {
    const observer = new MutationObserver(callback);
    observer.observe(target, options);
    Runtime.observers.push(observer);
  };

  const Platform = {
    isPlaying: (video) => !video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,

    findLikeButton: (box) => box?.querySelector(CONFIG.platform.playerDigg) || box?.querySelector(CONFIG.platform.feedDigg),

    getLikeState(button) {
      if (!button) return "UNKNOWN";
      const state = button.getAttribute("data-e2e-state");
      if (state === CONFIG.platform.stateLiked) return "LIKED";
      if (state === CONFIG.platform.stateUnliked) return "UNLIKED";
      return "UNKNOWN";
    },

    getVideoContext(player) {
      const id = player.getAttribute("data-e2e-vid")?.trim();
      const video = player.querySelector("video");
      if (!id || !CONFIG.platform.vidPattern.test(id) || !video) return null;
      return { id, video, likeButton: Platform.findLikeButton(player) };
    },

    getCurrentVideo() {
      const player = document.querySelector(CONFIG.platform.activePlayer);
      if (!player) return null;
      const ctx = Platform.getVideoContext(player);
      if (!ctx) return null;

      const modalId = new URL(location.href).searchParams.get("modal_id");
      if (modalId && CONFIG.platform.vidPattern.test(modalId) && modalId !== ctx.id) return null;
      return ctx;
    },
  };

  const Records = {
    rolloverIfNeeded() {
      const now = formatDate(new Date());
      if (now === AppState.today) return;
      AppState.today = now;
      for (const id of Object.keys(AppState.records)) delete AppState.records[id];
    },

    getCount: () => Object.keys(AppState.records).length,

    save() {
      Records.rolloverIfNeeded();
      GM_setValue(CONFIG.STORAGE_KEY, { date: AppState.today, records: AppState.records });
    },

    record(id) {
      Records.rolloverIfNeeded();
      if (AppState.records[id]) return;
      AppState.records[id] = true;
      Records.save();
      UI.updateUI();
    },

    export() {
      Records.rolloverIfNeeded();
      const ids = Object.keys(AppState.records);
      const blob = new Blob([JSON.stringify({ date: AppState.today, total: ids.length, ids }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `douyin_video_ids_${AppState.today}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
  };

  const AutoLike = {
    pressZ() {
      const options = { key: "z", code: "KeyZ", keyCode: 90, which: 90, bubbles: true, cancelable: true };
      document.dispatchEvent(new KeyboardEvent("keydown", options));
      document.dispatchEvent(new KeyboardEvent("keyup", options));
    },

    attachVideoEvents(video) {
      if (Runtime.boundVideos.has(video)) return;
      Runtime.boundVideos.add(video);
      const handler = () => AutoLike.process();
      CONFIG.platform.videoEvents.forEach((name) => on(video, name, handler));
      on(video, "timeupdate", AutoLike.onTimeUpdate);
    },

    getTargetSec: (video) => (video.duration > 0 && video.duration < CONFIG.timing.likeMs / 1000 ? CONFIG.timing.likeShortMs : CONFIG.timing.likeMs) / 1000,

    onTimeUpdate(event) {
      const s = AppState;
      const session = s.session;
      if (!s.running || !session || session.cancelled || session.triggered || document.hidden) return;

      const ctx = Platform.getCurrentVideo();
      if (!ctx || ctx.video !== event.currentTarget || ctx.id !== session.id || !Platform.isPlaying(ctx.video)) {
        session.lastTime = null;
        return;
      }

      const now = ctx.video.currentTime;
      if (session.lastTime === null) {
        session.lastTime = now;
        return;
      }

      const delta = now - session.lastTime;
      session.lastTime = now;
      if (delta > 0) session.watchedSec += Math.min(delta, CONFIG.timing.maxStepSec);

      if (session.watchedSec >= AutoLike.getTargetSec(ctx.video)) {
        AutoLike.fireAutoLike(ctx.id);
      }
    },

    createSession(id) {
      AppState.session = {
        id,
        triggered: AppState.triggeredIds.has(id),
        cancelled: false,
        autoLikeRequested: false,
        autoLiked: false,
        watchedSec: 0,
        lastTime: null,
      };
      AppState.manualAction = null;
      Records.record(id);
    },

    fireAutoLike(id) {
      const session = AppState.session;
      if (!session || session.id !== id || !AppState.running || session.cancelled || session.triggered) return;

      const ctx = Platform.getCurrentVideo();
      if (!ctx || ctx.id !== id || !Platform.isPlaying(ctx.video) || Platform.getLikeState(ctx.likeButton) !== "UNLIKED") return;

      session.triggered = true;
      session.autoLikeRequested = true;
      AppState.triggeredIds.add(id);
      AutoLike.pressZ();
      UI.setStatus(`视频 ${id}：已发送 Z，监测结果`, "#fe2c55");
    },

    process() {
      const s = AppState;
      if (!s.running) {
        UI.setStatus("自动点赞已停止", "#999");
        return;
      }
      if (document.hidden) return;

      const ctx = Platform.getCurrentVideo();
      if (!ctx) return;

      const { id, video, likeButton } = ctx;
      UI.setVideoId(id);

      if (!s.session || s.session.id !== id) AutoLike.createSession(id);
      AutoLike.attachVideoEvents(video);

      const session = s.session;
      if (session.cancelled || session.triggered) return;

      const state = Platform.getLikeState(likeButton);
      if (state === "LIKED") {
        session.triggered = true;
        s.triggeredIds.add(id);
        UI.setStatus(`视频 ${id}：已点赞，跳过`, "#fe2c55");
        return;
      }
      if (state === "UNLIKED") {
        UI.setStatus(`视频 ${id}：累计播放 ${AutoLike.getTargetSec(video)} 秒后点赞`);
      }
    },

    scheduleProcess() {
      if (AppState.frame) return;
      AppState.frame = requestAnimationFrame(() => {
        AppState.frame = 0;
        AutoLike.process();
      });
    },

    markManualAction(event) {
      const s = AppState;
      if (!s.running || !event.isTrusted || !s.session) return;

      const ctx = Platform.getCurrentVideo();
      if (!ctx || ctx.id !== s.session.id || Platform.getLikeState(ctx.likeButton) !== "LIKED") return;

      if (event.type === "keydown") {
        const target = event.target;
        if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) return;
        const key = event.key.toLowerCase();
        if ((key !== "z" && key !== "enter" && key !== " ") || event.repeat) return;
      } else {
        const target = event.target;
        if (!(target instanceof Element) || target.closest(CONFIG.platform.like) !== ctx.likeButton) return;
      }

      s.manualAction = { id: ctx.id, button: ctx.likeButton, time: performance.now() };
    },

    handleLikeMutation(mutation, target) {
      const s = AppState;
      if (!s.running || !s.session) return;

      const oldState = mutation.oldValue;
      const newState = target.getAttribute("data-e2e-state");
      const ctx = Platform.getCurrentVideo();
      if (!ctx || ctx.id !== s.session.id || ctx.likeButton !== target) return;

      const session = s.session;
      if (oldState === CONFIG.platform.stateUnliked && newState === CONFIG.platform.stateLiked && session.autoLikeRequested) {
        session.autoLikeRequested = false;
        session.autoLiked = true;
        UI.setStatus(`视频 ${ctx.id}：已点赞`, "#fe2c55");
        UI.updateUI();
        return;
      }

      if (
        oldState === CONFIG.platform.stateLiked &&
        newState === CONFIG.platform.stateUnliked &&
        session.autoLiked &&
        s.manualAction?.id === ctx.id &&
        performance.now() - s.manualAction.time < CONFIG.timing.manualActionWindowMs
      ) {
        session.cancelled = true;
        session.autoLiked = false;
        s.triggeredIds.delete(ctx.id);
        s.manualAction = null;
        UI.setStatus(`视频 ${ctx.id}：已手动取消点赞`, "#999");
        UI.updateUI();
      }
    },
  };

  const SleepTimer = {
    stop() {
      const t = AppState.timer;
      clearInterval(t.tickId);
      t.tickId = null;
      t.active = false;
      t.remainingMs = 0;
    },

    start(minutes) {
      SleepTimer.stop();
      const t = AppState.timer;
      t.active = true;
      t.remainingMs = minutes * 60_000;
      
      t.tickId = setInterval(() => {
        if (!t.active) return;
        const ctx = Platform.getCurrentVideo();
        const isPlaying = ctx ? Platform.isPlaying(ctx.video) : false;

        if (isPlaying) {
          t.remainingMs -= CONFIG.timing.playbackTickMs;
          if (t.remainingMs <= 0) {
            SleepTimer.finish();
            return;
          }
          UI.setTimerStatus(`剩余 ${formatRemaining(t.remainingMs)}`);
        } else {
          UI.setTimerStatus("定时已挂起 (视频暂停)");
        }
      }, CONFIG.timing.playbackTickMs);

      UI.updateTimerUI();
      UI.setTimerStatus(`剩余 ${formatRemaining(t.remainingMs)}`);
    },

    finish() {
      SleepTimer.stop();
      UI.updateTimerUI();
      const ctx = Platform.getCurrentVideo();
      if (!ctx) {
        UI.setTimerStatus("定时结束（未定位视频）");
        return;
      }
      ctx.video.pause();
      UI.setTimerStatus("定时结束已暂停");
    },
  };

  const UI = {
    el: {},
    css: `
      #dy-panel { position: fixed; right: 20px; bottom: 20px; z-index: 999999; width: 240px; border-radius: 14px; background: rgba(20,20,22,.94); color: #fff; font: 13px/1.6 sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.35); user-select: none; overflow: hidden; }
      #dy-panel.collapsed { width: auto; border-radius: 999px; }
      #dy-panel.collapsed #dy-body, #dy-panel.collapsed #dy-close { display: none; }
      #dy-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: move; }
      #dy-dot { width: 9px; height: 9px; flex: none; border-radius: 50%; }
      #dy-title { flex: 1; overflow: hidden; white-space: nowrap; }
      #dy-body { padding: 0 12px 12px; }
      #dy-status, #dy-video, #dy-count { font-size: 11px; overflow-wrap: anywhere; margin-bottom: 6px; }
      #dy-video, #dy-count { opacity: .75; }
      .dy-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
      .dy-switch { position: relative; display: inline-block; width: 44px; height: 26px; }
      .dy-switch input { opacity: 0; width: 0; height: 0; }
      .dy-slider { position: absolute; inset: 0; cursor: pointer; border-radius: 26px; background: #5a5a5e; transition: .2s; }
      .dy-slider:before { content: ""; position: absolute; left: 2px; bottom: 2px; width: 22px; height: 22px; border-radius: 50%; background: #fff; transition: .2s; }
      .dy-switch input:checked + .dy-slider { background: #41ff6a; }
      .dy-switch input:checked + .dy-slider:before { transform: translateX(18px); }
      #dy-close { cursor: pointer; opacity: .7; }
      #dy-timer-controls button, #dy-timer-custom { flex: 1; margin: 2px; padding: 4px; background: #2c2c30; border: none; color: #fff; border-radius: 4px; cursor: pointer; }
      #dy-timer-controls input { width: 40px; background: #2c2c30; border: 1px solid #444; color: #fff; text-align: center; border-radius: 4px; }
    `,
    html: `
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
          <label class="dy-switch"><input id="dy-toggle" type="checkbox" checked><span class="dy-slider"></span></label>
        </div>
        <fieldset id="dy-timer-controls" style="border:none; padding:0; margin:0 0 8px 0;">
          <div class="dy-row">
            <button type="button" data-minutes="10">10分</button>
            <button type="button" data-minutes="30">30分</button>
            <button type="button" data-minutes="60">1小时</button>
          </div>
          <div class="dy-row" style="gap: 4px;">
            <input id="dy-timer-hours" type="number" min="0" value="0">小
            <input id="dy-timer-minutes" type="number" min="0" value="0">分
            <button id="dy-timer-custom" type="button" style="margin:0;">自定义</button>
          </div>
        </fieldset>
        <div class="dy-row">
          <span id="dy-timer-status" style="font-size:11px; opacity:.75;">未启动</span>
          <button id="dy-timer-toggle" type="button" style="background:#ff4d4f; border:none; color:#fff; padding:2px 8px; border-radius:4px; cursor:pointer;" hidden>取消</button>
        </div>
      </div>
    `,

    mount() {
      GM_addStyle(UI.css);
      const panel = document.createElement("div");
      panel.id = "dy-panel";
      panel.className = "collapsed";
      panel.innerHTML = UI.html;
      document.body.appendChild(panel);
      Runtime.panel = panel;

      const $ = (s) => panel.querySelector(s);
      UI.el = {
        panel, status: $("#dy-status"), video: $("#dy-video"), count: $("#dy-count"),
        title: $("#dy-title"), dot: $("#dy-dot"), toggle: $("#dy-toggle"),
        timerControls: $("#dy-timer-controls"), timerHours: $("#dy-timer-hours"),
        timerMinutes: $("#dy-timer-minutes"), timerCustom: $("#dy-timer-custom"),
        timerCancel: $("#dy-timer-toggle"), timerStatus: $("#dy-timer-status"),
        close: $("#dy-close"), header: $("#dy-header"),
      };
    },

    contains: (node) => Boolean(node && (node === Runtime.panel || Runtime.panel.contains(node))),

    setStatus(message, color = "#f5a623") {
      if (message === AppState.lastStatus && color === AppState.lastColor) return;
      AppState.lastStatus = message;
      AppState.lastColor = color;
      UI.el.status.textContent = message;
      UI.el.status.style.color = color;
    },

    setVideoId: (id) => UI.el.video.textContent = `当前视频ID：${id}`,
    setTimerStatus: (msg) => UI.el.timerStatus.textContent = msg,

    updateTimerUI() {
      const active = AppState.timer.active;
      UI.el.timerControls.style.opacity = active ? "0.5" : "1";
      UI.el.timerCancel.hidden = !active;
    },

    updateUI() {
      const s = AppState;
      UI.el.dot.style.background = s.running ? "#2ecc71" : "#ff4d4f";
      UI.el.toggle.checked = s.running;
      UI.el.title.textContent = s.collapsed ? (s.running ? "运行中" : "暂停中") : "抖音自动点赞";
      UI.el.count.textContent = `今日累计刷视频：${Records.getCount()}`;
    },

    bindEvents() {
      const el = UI.el;
      on(el.toggle, "change", () => {
        AppState.running = el.toggle.checked;
        UI.updateUI();
        AutoLike.process();
      });

      on(el.timerControls, "click", (e) => {
        const btn = e.target.closest("[data-minutes]");
        if (btn) SleepTimer.start(Number(btn.dataset.minutes));
      });

      on(el.timerCustom, "click", () => {
        const mins = (el.timerHours.valueAsNumber || 0) * 60 + (el.timerMinutes.valueAsNumber || 0);
        if (mins > 0) SleepTimer.start(mins);
        else UI.setTimerStatus("请输入有效时长");
      });

      on(el.timerCancel, "click", () => { SleepTimer.stop(); UI.updateTimerUI(); UI.setTimerStatus("已取消"); });
      on(el.close, "click", () => { AppState.collapsed = true; Runtime.panel.classList.add("collapsed"); UI.updateUI(); });

      // 拖拽面板逻辑
      on(el.header, "pointerdown", (e) => {
        if (e.target.closest("#dy-close")) return;
        const rect = Runtime.panel.getBoundingClientRect();
        AppState.press = {
          id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false,
          timer: setTimeout(() => {
            AppState.press = null;
            if (AppState.collapsed) {
              AppState.collapsed = false;
              Runtime.panel.classList.remove("collapsed");
              UI.updateUI();
            }
          }, CONFIG.timing.longPressMs),
        };
        e.preventDefault();
      });

      on(document, "pointermove", (e) => {
        const p = AppState.press;
        if (!p || e.pointerId !== p.id) return;
        if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) >= CONFIG.timing.dragThresholdPx) {
          p.moved = true;
          clearTimeout(p.timer);
        }
        if (p.moved) {
          Runtime.panel.style.left = `${p.left + e.clientX - p.x}px`;
          Runtime.panel.style.top = `${p.top + e.clientY - p.y}px`;
          Runtime.panel.style.right = "auto";
          Runtime.panel.style.bottom = "auto";
        }
      });

      on(document, "pointerup", (e) => {
        if (AppState.press && e.pointerId === AppState.press.id) {
          clearTimeout(AppState.press.timer);
          AppState.press = null;
        }
      });
    },
  };

  // 初始化流程
  UI.mount();
  UI.bindEvents();

  // 观察 DOM 变动与路由变化
  observe(document.body, { childList: true, subtree: true }, (mutations) => {
    if (mutations.some((m) => !UI.contains(m.target.nodeType === 1 ? m.target : m.target.parentElement))) {
      AutoLike.scheduleProcess();
    }
  });

  observe(document.body, { attributes: true, subtree: true, attributeOldValue: true, attributeFilter: ["data-e2e-state", "data-e2e-vid"] }, (mutations) => {
    let check = false;
    for (const m of mutations) {
      const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (!target || UI.contains(target)) continue;
      if (m.attributeName === "data-e2e-state" && target.matches(CONFIG.platform.like)) {
        AutoLike.handleLikeMutation(m, target);
      }
      check = true;
    }
    if (check) AutoLike.scheduleProcess();
  });

  // 监听浏览器 History 路由切换
  const wrapHistory = (orig) => function (...args) {
    const res = orig.apply(this, args);
    AppState.manualAction = null;
    AutoLike.scheduleProcess();
    return res;
  };
  history.pushState = wrapHistory(history.pushState);
  history.replaceState = wrapHistory(history.replaceState);
  on(window, "popstate", () => AutoLike.scheduleProcess());

  // 全局交互监听
  on(document, "pointerdown", AutoLike.markManualAction, { capture: true });
  on(document, "keydown", AutoLike.markManualAction, { capture: true });
  on(document, "visibilitychange", () => {
    if (!document.hidden) {
      const ctx = Platform.getCurrentVideo();
      if (ctx && AppState.session?.id === ctx.id) AppState.session.lastTime = ctx.video.currentTime;
      AutoLike.process();
    }
  });

  GM_registerMenuCommand("导出今日刷视频数据", Records.export);

  Records.save();
  UI.updateUI();
  AutoLike.process();
})();