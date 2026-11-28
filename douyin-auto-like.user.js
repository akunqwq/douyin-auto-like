// ==UserScript==
// @name         抖音视频自动点赞Tampermonkey脚本
// @version      2.22.4
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

  const on = (target, type, handler, options = {}) => {
    target.addEventListener(type, handler, options);
  };

  const observe = (target, options, callback) => {
    new MutationObserver(callback).observe(target, options);
  };

const AppState = {
    collapsed: true,
    session: null,
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

  {
    const saved = GM_getValue(CONFIG.STORAGE_KEY, null);
    if (saved?.date === AppState.today) {
      if (saved.records && typeof saved.records === "object") {
        for (const [id, seen] of Object.entries(saved.records)) {
          if (seen && CONFIG.platform.vidPattern.test(id)) AppState.records[id] = true;
        }
      }
    }
  }

  const Runtime = {
    boundVideos: new WeakSet(),
    panel: null,
  };

const Platform = {
    isPlaying: (video) => !video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,

    isLive: (player) => Boolean(player?.querySelector(CONFIG.platform.live)),

    findLikeButton: (box) => box?.querySelector(CONFIG.platform.playerDigg) || box?.querySelector(CONFIG.platform.feedDigg),

    getLikeState(button) {
      const state = button?.getAttribute("data-e2e-state");
      if (state === CONFIG.platform.stateLiked) return "LIKED";
      return "UNLIKED";
    },

    getVideoContext(player, allowLive = false) {
      if (!allowLive && Platform.isLive(player)) return null;
      const id = player.getAttribute("data-e2e-vid")?.trim();
      const video = player.querySelector("video");
      if (!id || !CONFIG.platform.vidPattern.test(id) || !video) return null;
      return { id, video, likeButton: Platform.findLikeButton(player) };
    },

    getCurrentVideo(allowLive = false) {
      let first = null;
      for (const player of document.querySelectorAll(CONFIG.platform.activePlayer)) {
        const ctx = Platform.getVideoContext(player, allowLive);
        if (!ctx) continue;
        if (!first) first = ctx;
        if (Platform.isPlaying(ctx.video)) return ctx;
      }
      return first;
    },
  };

// 当日刷视频记录：被 process() 识别并创建过会话的视频 ID 集合。
  // 仅用于统计当日刷视频数量与导出，不代表已点赞 / 已看完 / 自动点赞成功，
  // 不参与跨会话去重——是否再次进入自动点赞流程由 Session 维度决定。
  const Records = {
    rolloverIfNeeded() {
      const now = formatDate(new Date());
      if (now === AppState.today) return;

      AppState.today = now;
      AppState.records = Object.create(null);
      AppState.session = null;
    },

    getCount() {
      Records.rolloverIfNeeded();
      return Object.keys(AppState.records).length;
    },

    save() {
      Records.rolloverIfNeeded();
      GM_setValue(CONFIG.STORAGE_KEY, {
        version: 3,
        date: AppState.today,
        records: AppState.records,
      });
    },

    // 会话创建即记录（由 createSession 调用），此时尚未点赞、尚未累计观看时长。
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
      if (!ids.length) {
        GM_notification({ title: "抖音自动点赞", text: "今日暂无可导出的刷视频记录" });
        return;
      }
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
      GM_notification({ title: "抖音自动点赞", text: `已导出今日刷视频记录 ${ids.length} 条` });
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

    getTargetSec(video) {
      const fullSec = CONFIG.timing.likeMs / 1000;
      const shortSec = CONFIG.timing.likeShortMs / 1000;
      const dur = video.duration;
      if (!Number.isFinite(dur) || dur <= 0) return fullSec;
      // 抖音时长显示取整：UI 显示 0:10 的视频实际 duration 常是 10.04 / 10.2，
      // 严格 <= fullSec 会把这些漏判到 long 档，用 round 容忍 ±0.5s 误差
      const target = Math.round(dur) <= fullSec ? shortSec : fullSec;
      // 比目标还短的视频（如 2 秒），不能让它等 3 秒触发，留 duration-0.5 兜底
      return Math.min(target, Math.max(dur - 0.5, 0.5));
    },

    onTimeUpdate(event) {
      const session = AppState.session;
      if (!session || session.triggered || document.hidden) return;

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
        triggered: false,
        autoLikeRequested: false,
        watchedSec: 0,
        lastTime: null,
      };
      Records.record(id);
    },

    fireAutoLike(id) {
      const session = AppState.session;
      if (!session || session.id !== id || session.triggered) return;

      const ctx = Platform.getCurrentVideo();
      if (!ctx || ctx.id !== id || !Platform.isPlaying(ctx.video)) return;

      if (Platform.getLikeState(ctx.likeButton) === "LIKED") {
        session.triggered = true;
        UI.setStatus("已点赞，跳过自动点赞", "#fe2c55");
        return;
      }

      session.triggered = true;
      session.autoLikeRequested = true;
      AutoLike.pressZ();
      UI.setStatus("已发送 Z，等待确认", "#fe2c55");

      setTimeout(() => {
        if (AppState.session !== session || !session.autoLikeRequested) return;
        session.autoLikeRequested = false;
        const current = Platform.getCurrentVideo();
        if (!current || current.id !== id) return;
        if (Platform.getLikeState(current.likeButton) === "LIKED") {
          UI.setStatus("已点赞", "#fe2c55");
          UI.updateUI();
        } else {
          UI.setStatus("未确认到点赞，请手动点赞", "#f5a623");
        }
      }, CONFIG.timing.confirmWindowMs);
    },

    process() {
      Records.rolloverIfNeeded();

      if (document.hidden) return;

      const ctx = Platform.getCurrentVideo();
      if (!ctx) return;

      const { id, video } = ctx;

      if (!AppState.session || AppState.session.id !== id) AutoLike.createSession(id);
      AutoLike.attachVideoEvents(video);

      const session = AppState.session;
      if (session.triggered) return;

      if (Platform.getLikeState(ctx.likeButton) === "LIKED") {
        session.triggered = true;
        UI.setStatus("已点赞，跳过", "#fe2c55");
        return;
      }

      UI.setStatus(`累计播放 ${AutoLike.getTargetSec(video)} 秒后点赞`);
    },

    scheduleProcess() {
      if (AppState.frame) return;
      const delay = Math.max(0, 200 - (performance.now() - AppState.lastProcessAt));
      AppState.frame = setTimeout(() => {
        AppState.frame = 0;
        AppState.lastProcessAt = performance.now();
        AutoLike.process();
      }, delay);
    },

    handleLikeMutation(mutation, target) {
      Records.rolloverIfNeeded();

      const session = AppState.session;
      if (!session) return;

      const oldState = mutation.oldValue;
      const newState = target.getAttribute("data-e2e-state");
      const ctx = Platform.getCurrentVideo();
      if (!ctx || ctx.id !== session.id) return;

      if (oldState === CONFIG.platform.stateUnliked && newState === CONFIG.platform.stateLiked && session.autoLikeRequested) {
        session.autoLikeRequested = false;
        UI.setStatus("已点赞", "#fe2c55");
        UI.updateUI();
        return;
      }

      if (oldState === CONFIG.platform.stateLiked && newState === CONFIG.platform.stateUnliked) {
        session.triggered = true;
        session.autoLikeRequested = false;
        UI.setStatus("已手动取消，本次观看不再处理", "#999");
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

        const ctx = Platform.getCurrentVideo(true);
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
        const elapsed = Math.max(0, Math.min(now - lastTick, CONFIG.timing.playbackTickMs * 5));
        lastTick = now;

        const ctx = Platform.getCurrentVideo(true);
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
      const ctx = Platform.getCurrentVideo(true);
      const isPlaying = ctx ? Platform.isPlaying(ctx.video) : false;
      SleepTimer.syncIdleTimeout(isPlaying);
      UI.setTimerStatus(isPlaying ? `剩余 ${formatRemaining(t.remainingMs)}` : "挂起，视频暂停中...");
    },

    finish() {
      SleepTimer.stop();
      UI.updateTimerUI();
      Platform.getCurrentVideo(true)?.video.pause();
      const message = "定时结束，任务完成";
      UI.setTimerStatus(message);
      SleepTimer.notify(message);
    },
  };

const UI = {
    el: {},
    css: `
#dy-panel { position: fixed; right: 20px; bottom: 20px; z-index: 999999; width: 280px; border-radius: 14px; background: rgba(20,20,22,.94); color: #fff; font: 13px/1.6 sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.35); user-select: none; overflow: hidden; }
#dy-panel.collapsed { width: auto; border-radius: 999px; }
#dy-panel.collapsed #dy-body, #dy-panel.collapsed #dy-close { display: none; }
#dy-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: move; }
#dy-dot { width: 9px; height: 9px; flex: none; border-radius: 50%; background: #2ecc71; }
#dy-title { flex: 1; overflow: hidden; white-space: nowrap; }
#dy-body { padding: 0 12px 12px; }
.dy-section { padding: 10px 0; border-top: 1px solid rgba(255,255,255,.08); }
.dy-section:first-child { border-top: none; padding-top: 2px; }
.dy-label { font-size: 11px; opacity: .55; margin-bottom: 2px; }
.dy-value { font-size: 12px; overflow-wrap: anywhere; }
.dy-value + .dy-label, .dy-value + .dy-row { margin-top: 8px; }
.dy-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.dy-row .dy-label { margin-bottom: 0; }
#dy-close { cursor: pointer; opacity: .7; }
#dy-timer-controls { border: none; padding: 0; margin: 0; }
.dy-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 6px 0; }
.dy-grid button, .dy-custom button { padding: 5px 0; background: #2c2c30; border: none; color: #fff; border-radius: 6px; cursor: pointer; }
.dy-custom { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
.dy-custom input { width: 46px; padding: 5px 4px; background: #2c2c30; border: 1px solid #444; color: #fff; text-align: center; border-radius: 6px; }
.dy-custom button { flex: 1; }
#dy-timer-status { font-size: 12px; opacity: .75; flex: 1; }
#dy-timer-toggle { background: #ff4d4f; border: none; color: #fff; padding: 3px 10px; border-radius: 6px; cursor: pointer; }
`,
    html: `
<div id="dy-header">
  <span id="dy-dot"></span>
  <span id="dy-title">抖音自动点赞</span>
  <span id="dy-close">✕</span>
</div>
<div id="dy-body">
  <div class="dy-section">
    <div class="dy-label">运行状态</div>
    <div class="dy-value" id="dy-status">未启动</div>
    <div class="dy-row">
      <span class="dy-label">今日刷视频</span>
      <span class="dy-value" id="dy-count">0 条</span>
    </div>
  </div>
  <div class="dy-section">
    <div class="dy-label">播放定时</div>
    <fieldset id="dy-timer-controls">
      <div class="dy-grid">
        <button type="button" data-minutes="5">5分钟</button>
        <button type="button" data-minutes="10">10分钟</button>
        <button type="button" data-minutes="15">15分钟</button>
        <button type="button" data-minutes="20">20分钟</button>
        <button type="button" data-minutes="30">30分钟</button>
        <button type="button" data-minutes="45">45分钟</button>
        <button type="button" data-minutes="60">1小时</button>
        <button type="button" data-minutes="120">2小时</button>
      </div>
      <div class="dy-label">自定义时长</div>
      <div class="dy-custom">
        <input id="dy-timer-hours" type="number" min="0" value="0">时
        <input id="dy-timer-minutes" type="number" min="0" value="0">分
        <button id="dy-timer-custom" type="button">开始定时</button>
      </div>
    </fieldset>
    <div class="dy-label">定时状态</div>
    <div class="dy-row">
      <span id="dy-timer-status">未启动</span>
      <button id="dy-timer-toggle" type="button" hidden>取消</button>
    </div>
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
        panel, status: $("#dy-status"), count: $("#dy-count"),
        title: $("#dy-title"), timerControls: $("#dy-timer-controls"), timerHours: $("#dy-timer-hours"),
        timerMinutes: $("#dy-timer-minutes"), timerCustom: $("#dy-timer-custom"),
        timerCancel: $("#dy-timer-toggle"), timerStatus: $("#dy-timer-status"),
        close: $("#dy-close"), header: $("#dy-header"),
      };

      UI.el.status.textContent = AppState.lastStatus || "未启动";
      UI.el.count.textContent = `${Records.getCount()} 条`;
    },

    contains: (node) => Boolean(node && (node === Runtime.panel || Runtime.panel.contains(node))),

    setStatus(message, color = "#f5a623") {
      if (message === AppState.lastStatus && color === AppState.lastColor) return;
      AppState.lastStatus = message;
      AppState.lastColor = color;
      UI.el.status.textContent = message;
      UI.el.status.style.color = color;
    },

    setTimerStatus: (msg) => UI.el.timerStatus.textContent = msg,

    updateTimerUI() {
      const active = AppState.timer.active;
      UI.el.timerControls.style.opacity = active ? "0.5" : "1";
      UI.el.timerCancel.hidden = !active;
    },

    updateUI() {
      UI.el.title.textContent = AppState.collapsed ? "运行中" : "抖音自动点赞";
      UI.el.count.textContent = `${Records.getCount()} 条`;
    },

    bindEvents() {
      const el = UI.el;
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

UI.mount();
  UI.bindEvents();

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

  GM_registerMenuCommand("今日刷视频记录导出", Records.export);

  Records.save();
  UI.updateUI();
  AutoLike.process();

})();
