// ==UserScript==
// @name         抖音视频自动点赞Tampermonkey脚本
// @version      2.11.0
// @description  自动点赞当前正在观看的未点赞视频、睡眠定时功能
// @author       是阿鲲鸭
// @match        https://www.douyin.com/*
// @noframes
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    STORAGE_KEY: "dy_auto_like_data",
    platform: {
      activePlayer: '[data-e2e="feed-active-video"][data-e2e-vid]',
      live: '[data-e2e="live-slider"]',
      playerDigg: '[data-e2e="video-player-digg"]',
      feedDigg: '[data-e2e="feed-digg"]',
      stateLiked: "video-player-is-digged",
      stateUnliked: "video-player-no-digged",
      vidPattern: /^\d+$/,
      videoEvents: ["playing", "play", "pause", "waiting", "stalled", "ended", "canplay", "loadeddata"],
    },
    timing: {
      likeMs: 10_000,
      likeShortMs: 3_000,
      maxStepSec: 1,
      confirmWindowMs: 2_000,
      playbackTickMs: 1_000,
      maxIdleMs: 4 * 60 * 60_000,
      longPressMs: 500,
      dragThresholdPx: 5,
    },
  };

  // 点赞按钮选择器统一由两个来源拼出，避免抖音页面更新导致选择器失效
  CONFIG.platform.like = `${CONFIG.platform.playerDigg}, ${CONFIG.platform.feedDigg}`;

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
    triggeredIds: new Set(),
    cancelled: Object.create(null),
    frame: 0,
    lastProcessAt: 0,
    today: formatDate(new Date()),
    records: Object.create(null),
    lastStatus: "",
    lastColor: "",
    press: null,
    timer: {
      active: false,
      remainingMs: 0,
      tickId: null,
      idleTimeoutId: null,
    },
  };

  // 初始化加载本地记录
  {
    const saved = GM_getValue(CONFIG.STORAGE_KEY, null);
    if (saved?.date === AppState.today) {
      if (saved.records && typeof saved.records === "object") {
        for (const [id, viewed] of Object.entries(saved.records)) {
          if (viewed && CONFIG.platform.vidPattern.test(id)) AppState.records[id] = true;
        }
      }
      if (saved.cancelled && typeof saved.cancelled === "object") {
        for (const [id, flagged] of Object.entries(saved.cancelled)) {
          if (flagged && CONFIG.platform.vidPattern.test(id)) AppState.cancelled[id] = true;
        }
      }
    }
  }

  const Runtime = {
    controller: new AbortController(),
    observers: [],
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

    isLive: (player) => Boolean(player?.querySelector(CONFIG.platform.live)),

    findLikeButton: (box) => box?.querySelector(CONFIG.platform.playerDigg) || box?.querySelector(CONFIG.platform.feedDigg),

    getLikeState(button) {
      // 只有已赞/未赞两态，读不到时按未赞处理
      const state = button?.getAttribute("data-e2e-state");
      if (state === CONFIG.platform.stateLiked) return "LIKED";
      return "UNLIKED";
    },

    getModalId() {
      const id = new URL(location.href).searchParams.get("modal_id");
      return id && CONFIG.platform.vidPattern.test(id) ? id : null;
    },

    getVideoContext(player) {
      if (Platform.isLive(player)) return null;
      const id = player.getAttribute("data-e2e-vid")?.trim();
      const video = player.querySelector("video");
      if (!id || !CONFIG.platform.vidPattern.test(id) || !video) return null;
      return { id, video, likeButton: Platform.findLikeButton(player) };
    },

    getCurrentVideo() {
      const modalId = Platform.getModalId();
      if (modalId) {
        const modalPlayer = document.querySelector(`[data-e2e-vid="${modalId}"]`) || document.querySelector(CONFIG.platform.activePlayer);
        if (modalPlayer) {
          const video = modalPlayer.querySelector("video");
          if (video) {
            return {
              id: modalId,
              video,
              likeButton: Platform.findLikeButton(modalPlayer),
            };
          }
        }
      }

      // 常规推荐流
      const player = document.querySelector(CONFIG.platform.activePlayer);
      if (!player) return null;
      return Platform.getVideoContext(player);
    },
  };

  const Records = {
    rolloverIfNeeded() {
      const now = formatDate(new Date());
      if (now === AppState.today) return;
      AppState.today = now;
      AppState.records = Object.create(null);
      AppState.cancelled = Object.create(null);
    },

    getCount() {
      Records.rolloverIfNeeded();
      return Object.keys(AppState.records).length;
    },

    save() {
      Records.rolloverIfNeeded();
      GM_setValue(CONFIG.STORAGE_KEY, {
        version: 2,
        date: AppState.today,
        records: AppState.records,
        cancelled: AppState.cancelled,
      });
    },

    record(id) {
      Records.rolloverIfNeeded();
      if (AppState.records[id]) return;
      AppState.records[id] = true;
      Records.save();
      UI.updateUI();
    },

    // 用户手动取消后，当天内该视频不再自动点赞
    cancel(id) {
      Records.rolloverIfNeeded();
      if (AppState.cancelled[id]) return;
      AppState.cancelled[id] = true;
      Records.save();
    },

    export() {
      Records.rolloverIfNeeded();
      const ids = Object.keys(AppState.records);
      const blob = new Blob([JSON.stringify({ date: AppState.today, total: ids.length, ids }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `douyin_video_ids_${AppState.today}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 0);
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
      const cancelled = Boolean(AppState.cancelled[id]);
      AppState.session = {
        id,
        triggered: AppState.triggeredIds.has(id) || cancelled,
        cancelled,
        autoLikeRequested: false,
        autoLiked: false,
        watchedSec: 0,
        lastTime: null,
      };
      Records.record(id);
    },

    fireAutoLike(id) {
      const session = AppState.session;
      if (!session || session.id !== id || !AppState.running || session.cancelled || session.triggered) return;

      const ctx = Platform.getCurrentVideo();
      if (!ctx || ctx.id !== id || !Platform.isPlaying(ctx.video)) return;

      if (Platform.getLikeState(ctx.likeButton) !== "UNLIKED") return;

      session.triggered = true;
      session.autoLikeRequested = true;
      AppState.triggeredIds.add(id);
      AutoLike.pressZ();
      UI.setStatus(`视频 ${id}：已发送 Z，等待确认`, "#fe2c55");

      // 2 秒后仍未确认则提示失败，不自动重试，避免二次 toggle
      setTimeout(() => {
        if (AppState.session !== session || !session.autoLikeRequested) return;
        session.autoLikeRequested = false;
        const current = Platform.getCurrentVideo();
        if (!current || current.id !== id) return;
        if (Platform.getLikeState(current.likeButton) === "LIKED") {
          session.autoLiked = true;
          UI.setStatus(`视频 ${id}：已点赞`, "#fe2c55");
          UI.updateUI();
        } else {
          UI.setStatus(`视频 ${id}：未确认到点赞，请手动点赞`, "#f5a623");
        }
      }, CONFIG.timing.confirmWindowMs);
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

      const { id, video } = ctx;
      UI.setVideoId(id);

      if (!s.session || s.session.id !== id) AutoLike.createSession(id);
      AutoLike.attachVideoEvents(video);

      const session = s.session;

      if (session.cancelled) {
        UI.setStatus(`视频 ${id}：已手动取消，今日不再自动点赞`, "#999");
        return;
      }
      if (session.triggered) return;

      const state = Platform.getLikeState(ctx.likeButton);
      if (state === "LIKED") {
        session.triggered = true;
        s.triggeredIds.add(id);
        UI.setStatus(`视频 ${id}：已点赞，跳过`, "#fe2c55");
        return;
      }
      UI.setStatus(`视频 ${id}：累计播放 ${AutoLike.getTargetSec(video)} 秒后点赞`);
    },

    scheduleProcess() {
      if (AppState.frame) return;
      // 合并高频 DOM 变化，最多每 200ms 处理一次，避免每帧重复查询 DOM
      const delay = Math.max(0, 200 - (performance.now() - AppState.lastProcessAt));
      AppState.frame = setTimeout(() => {
        AppState.frame = 0;
        AppState.lastProcessAt = performance.now();
        AutoLike.process();
      }, delay);
    },

    handleLikeMutation(mutation, target) {
      const s = AppState;
      if (!s.running || !s.session) return;

      const session = s.session;
      const oldState = mutation.oldValue;
      const newState = target.getAttribute("data-e2e-state");
      const ctx = Platform.getCurrentVideo();
      if (!ctx || ctx.id !== session.id) return;

      if (oldState === CONFIG.platform.stateUnliked && newState === CONFIG.platform.stateLiked && session.autoLikeRequested) {
        session.autoLikeRequested = false;
        session.autoLiked = true;
        UI.setStatus(`视频 ${ctx.id}：已点赞`, "#fe2c55");
        UI.updateUI();
        return;
      }

      // 脚本只会点赞、不会取消，因此 LIKED → UNLIKED 一律视为用户手动取消
      if (oldState === CONFIG.platform.stateLiked && newState === CONFIG.platform.stateUnliked) {
        session.cancelled = true;
        session.autoLiked = false;
        session.autoLikeRequested = false;
        s.triggeredIds.delete(ctx.id);
        Records.cancel(ctx.id);
        UI.setStatus(`视频 ${ctx.id}：已手动取消，今日不再自动点赞`, "#999");
        UI.updateUI();
      }
    },
  };

  const SleepTimer = {
    notify(text) {
      GM_notification({ title: "抖音自动点赞", text });
    },

    clearIdleTimeout() {
      const t = AppState.timer;
      clearTimeout(t.idleTimeoutId);
      t.idleTimeoutId = null;
    },

    stop() {
      const t = AppState.timer;
      clearInterval(t.tickId);
      SleepTimer.clearIdleTimeout();
      t.tickId = null;
      t.active = false;
      t.remainingMs = 0;
    },

    syncIdleTimeout(isPlaying) {
      const t = AppState.timer;
      if (!t.active || isPlaying) {
        SleepTimer.clearIdleTimeout();
        return;
      }
      if (t.idleTimeoutId !== null) return;

      t.idleTimeoutId = setTimeout(() => {
        t.idleTimeoutId = null;
        if (!t.active) return;

        const ctx = Platform.getCurrentVideo();
        if (ctx && Platform.isPlaying(ctx.video)) return;

        SleepTimer.stop();
        UI.updateTimerUI();
        const message = "连续 4 小时未播放，睡眠定时已终止";
        UI.setTimerStatus(message);
        SleepTimer.notify(message);
      }, CONFIG.timing.maxIdleMs);
    },

    start(minutes) {
      SleepTimer.stop();
      const t = AppState.timer;
      t.active = true;
      t.remainingMs = minutes * 60_000;
      let lastState = null;
      let lastTick = performance.now();

      t.tickId = setInterval(() => {
        if (!t.active) return;

        const now = performance.now();
        // 按真实经过时间扣减，规避 setInterval 漂移；单次最多计 5 秒，避免休眠/节流后瞬跳
        const elapsed = Math.max(0, Math.min(now - lastTick, CONFIG.timing.playbackTickMs * 5));
        lastTick = now;

        const ctx = Platform.getCurrentVideo();
        const isPlaying = ctx ? Platform.isPlaying(ctx.video) : false;
        SleepTimer.syncIdleTimeout(isPlaying);

        if (isPlaying) {
          t.remainingMs -= elapsed;
          if (t.remainingMs <= 0) {
            SleepTimer.finish();
            return;
          }
          lastState = true;
          UI.setTimerStatus(`剩余 ${formatRemaining(t.remainingMs)}`);
        } else {
          if (lastState !== false) UI.setTimerStatus("挂起，视频暂停中...");
          lastState = false;
        }
      }, CONFIG.timing.playbackTickMs);

      UI.updateTimerUI();
      const ctx = Platform.getCurrentVideo();
      const isPlaying = ctx ? Platform.isPlaying(ctx.video) : false;
      SleepTimer.syncIdleTimeout(isPlaying);
      UI.setTimerStatus(isPlaying ? `剩余 ${formatRemaining(t.remainingMs)}` : "挂起，视频暂停中...");
    },

    finish() {
      SleepTimer.stop();
      UI.updateTimerUI();
      const ctx = Platform.getCurrentVideo();
      if (!ctx) {
        const message = "任务中止，检测到非视频页面";
        UI.setTimerStatus(message);
        SleepTimer.notify(message);
        return;
      }
      ctx.video.pause();
      const message = "定时结束，任务完成";
      UI.setTimerStatus(message);
      SleepTimer.notify(message);
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
        <div id="dy-status">未启动</div>
        <div id="dy-video">当前识别视频 ID：为空</div>
        <div id="dy-count">今日累计刷视频数据：0</div>
        <div class="dy-row">
          <span>启动开关</span>
          <label class="dy-switch"><input id="dy-toggle" type="checkbox" checked><span class="dy-slider"></span></label>
        </div>
        <fieldset id="dy-timer-controls" style="border:none; padding:0; margin:0 0 8px 0;">
          <div class="dy-row">
            <button type="button" data-minutes="5">5分</button>
            <button type="button" data-minutes="10">10分</button>
            <button type="button" data-minutes="15">15分</button>
            <button type="button" data-minutes="20">20分</button>
            <button type="button" data-minutes="30">30分</button>
            <button type="button" data-minutes="45">45分</button>
            <button type="button" data-minutes="60">1小时</button>
            <button type="button" data-minutes="120">2小时</button>
          </div>
          <div class="dy-row" style="gap: 4px;">
            <input id="dy-timer-hours" type="number" min="0" value="0">时
            <input id="dy-timer-minutes" type="number" min="0" value="0">分
            <button id="dy-timer-custom" type="button" style="margin:0;">自定义时间</button>
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

      UI.el.status.textContent = AppState.lastStatus || "未启动";
      UI.el.video.textContent = `当前识别视频 ID：${AppState.session?.id ?? "为空"}`;
      UI.el.count.textContent = `今日累计刷视频数据：${Records.getCount()}`;
    },

    contains: (node) => Boolean(node && (node === Runtime.panel || Runtime.panel.contains(node))),

    setStatus(message, color = "#f5a623") {
      if (message === AppState.lastStatus && color === AppState.lastColor) return;
      AppState.lastStatus = message;
      AppState.lastColor = color;
      UI.el.status.textContent = message;
      UI.el.status.style.color = color;
    },

    setVideoId(id) {
      const text = `当前识别视频 ID：${id}`;
      if (UI.el.video.textContent !== text) UI.el.video.textContent = text;
    },
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
      UI.el.count.textContent = `今日累计刷视频数据：${Records.getCount()}`;
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
        if (!Number.isFinite(mins) || mins <= 0) {
          UI.setTimerStatus("请输入有效时长");
          return;
        }
        SleepTimer.start(Math.min(mins, 24 * 60));
      });

      on(el.timerCancel, "click", () => { SleepTimer.stop(); UI.updateTimerUI(); UI.setTimerStatus("已取消"); });
      on(el.close, "click", () => { AppState.collapsed = true; Runtime.panel.classList.add("collapsed"); UI.updateUI(); });

      // 可拖拽面板
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

  // UI初始化
  UI.mount();
  UI.bindEvents();

  // 监听 DOM 变化，触发自动点赞处理
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

  // 监听路由变化
  const wrapHistory = (orig) => function (...args) {
    const res = orig.apply(this, args);
    AutoLike.scheduleProcess();
    return res;
  };
  history.pushState = wrapHistory(history.pushState);
  history.replaceState = wrapHistory(history.replaceState);
  on(window, "popstate", () => AutoLike.scheduleProcess());

  on(document, "visibilitychange", () => {
    if (!document.hidden) {
      const ctx = Platform.getCurrentVideo();
      if (ctx && AppState.session?.id === ctx.id) AppState.session.lastTime = ctx.video.currentTime;
      AutoLike.process();
    }
  });

  GM_registerMenuCommand("导出数据", Records.export);

  Records.save();
  UI.updateUI();
  AutoLike.process();
})();
