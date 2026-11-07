// ==UserScript==
// @name         抖音自动点赞
// @version      2.6.6
// @description  视频播放后延迟点赞（默认 10 秒，不足 10 秒的短视频降至 3 秒），通过 Z 键通道自动点赞，跟踪点赞状态与手动取消；另附独立睡眠定时功能，可在设定时间后暂停当前视频，避免刷视频过久。
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

  /* ================================================================
   * §1 CONFIG / UTILS — 全局常量与工具函数
   * ================================================================ */

  const CONFIG = (() => {
    const playerDigg = '[data-e2e="video-player-digg"]';
    const feedDigg = '[data-e2e="feed-digg"]';

    return {
      STORAGE_KEY: "dy_auto_like_data",


      platform: {
        activePlayer: '[data-e2e="feed-active-video"][data-e2e-vid]',
        playerDigg,
        feedDigg,
        like: `${playerDigg}, ${feedDigg}`,
        stateLiked: "video-player-is-digged",
        stateUnliked: "video-player-no-digged",
        vidPattern: /^\d+$/,
        videoEvents: [
          "playing",
          "play",
          "pause",
          "waiting",
          "stalled",
          "ended",
          "canplay",
          "loadeddata",
        ],
      },

      timing: {
        likeMs: 10_000,
        // 默认阈值对短视频意味着「播完也没点到」，降至 3s 让点赞有机会生效。
        likeShortMs: 3_000,
        manualActionWindowMs: 2_000,
        playbackTickMs: 1_000,
        longPressMs: 500,
        dragThresholdPx: 5,
      },
    };
  })();

  function formatDate(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function formatRemaining(ms) {
    const total = Math.ceil(ms / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function parseDuration(hours, minutes) {
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
    if (hours < 0 || minutes < 0) return null;

    const total = hours * 60 + minutes;

    return total > 0 ? total : null;
  }

  /* ================================================================
   * §2 STATE / LIFECYCLE — 全局可变状态与资源句柄
   * AppState 装业务状态（可重置），Runtime 装需 dispose 的资源，两者清空方式不同。
   * ================================================================ */

  const AppState = {
    running: true,
    // 默认收起
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

    timer: {
      endAt: 0,
      timeoutId: null,
      tickId: null,
    },
  };

  {
    const saved = GM_getValue(CONFIG.STORAGE_KEY, null);

    if (
      saved?.date === AppState.today &&
      saved.records &&
      typeof saved.records === "object" &&
      !Array.isArray(saved.records)
    ) {
      for (const [id, viewed] of Object.entries(saved.records)) {
        if (viewed === true && CONFIG.platform.vidPattern.test(id)) {
          AppState.records[id] = true;
        }
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

  // 所有 DOM 监听挂同一 signal，卸载时一次 abort 全清；散装 addEventListener 无法批量回收。
  function on(target, type, handler, options = {}) {
    target.addEventListener(type, handler, {
      ...options,
      signal: Runtime.controller.signal,
    });
  }

  function observe(target, options, callback) {
    const observer = new MutationObserver(callback);
    observer.observe(target, options);
    Runtime.observers.push(observer);
    return observer;
  }

  function onDispose(fn) {
    Runtime.disposers.push(fn);
  }

  // 预留后续的「完全卸载」开关；当前不注册入口。
  function destroy() {
    Runtime.controller.abort();
    for (const observer of Runtime.observers) observer.disconnect();
    for (const dispose of Runtime.disposers) dispose();
    cancelAnimationFrame(AppState.frame);
    Runtime.panel?.remove();
  }

  /* ================================================================
   * §3 PLATFORM ADAPTER — 唯一读取抖音 DOM 的地方
   * 纯查询，不写 AppState，不碰 UI，不注册监听。
   * ================================================================ */

  const Platform = {
    isPlaying(video) {
      return (
        !video.paused &&
        !video.ended &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      );
    },

    findLikeButton(box) {
      if (!box) return null;

      return (
        box.querySelector(CONFIG.platform.playerDigg) ||
        box.querySelector(CONFIG.platform.feedDigg)
      );
    },

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

      if (!id || !CONFIG.platform.vidPattern.test(id) || !video) {
        return null;
      }

      return {
        id,
        video,
        likeButton: Platform.findLikeButton(player),
      };
    },

    getModalId() {
      const id = new URL(location.href).searchParams.get("modal_id");

      return id && CONFIG.platform.vidPattern.test(id) ? id : null;
    },

    getCurrentVideo() {
      const player = document.querySelector(CONFIG.platform.activePlayer);

      if (!player) return null;

      const ctx = Platform.getVideoContext(player);
      if (!ctx) return null;

      const modalId = Platform.getModalId();
      if (modalId && modalId !== ctx.id) return null;

      return ctx;
    },
  };

  /* ================================================================
   * §4 AUTO LIKE — 自动点赞业务 + 今日记录
   * 状态输出一律经 UI.*，不直接操作面板节点。
   * ================================================================ */

  const Records = {
    rolloverIfNeeded() {
      const now = formatDate(new Date());
      if (now === AppState.today) return;

      AppState.today = now;

      for (const id of Object.keys(AppState.records)) {
        delete AppState.records[id];
      }
    },

    getCount() {
      return Object.keys(AppState.records).length;
    },

    save() {
      Records.rolloverIfNeeded();
      GM_setValue(CONFIG.STORAGE_KEY, {
        date: AppState.today,
        records: AppState.records,
      });
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
      const a = document.createElement("a");

      a.href =
        "data:application/json;charset=utf-8," +
        encodeURIComponent(
          JSON.stringify(
            {
              date: AppState.today,
              total: ids.length,
              ids,
            },
            null,
            2,
          ),
        );

      a.download = `douyin_video_ids_${AppState.today}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    registerMenu() {
      GM_registerMenuCommand("导出今日刷视频数据", Records.export);
    },
  };

  const AutoLike = {
    pressZ() {
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
    },

    attachVideoEvents(video) {
      if (Runtime.boundVideos.has(video)) return;
      Runtime.boundVideos.add(video);

      const handler = () => AutoLike.process();
      for (const name of CONFIG.platform.videoEvents) {
        on(video, name, handler);
      }
    },

    createSession(id) {
      if (AppState.session?.pendingTimer) {
        clearTimeout(AppState.session.pendingTimer);
      }

      AppState.session = {
        id,
        triggered: AppState.triggeredIds.has(id),
        cancelled: false,
        autoLikeRequested: false,
        autoLiked: false,
        pendingTimer: null,
        pendingUntil: 0,
        // 后台冻结的剩余时间；null 表示未冻结，0 是合法冻结值。
        frozenRemaining: null,
      };

      AppState.manualAction = null;
      Records.record(id);
    },

    fireAutoLike(id) {
      const session = AppState.session;
      if (!session || session.id !== id) return;

      session.pendingTimer = null;

      if (!AppState.running || session.cancelled || session.triggered) {
        return;
      }

      const ctx = Platform.getCurrentVideo();

      if (!ctx || ctx.id !== id || !Platform.isPlaying(ctx.video)) {
        return;
      }

      if (Platform.getLikeState(ctx.likeButton) !== "UNLIKED") {
        return;
      }

      session.triggered = true;
      session.autoLikeRequested = true;
      AppState.triggeredIds.add(id);

      AutoLike.pressZ();

      UI.setStatus(`视频 ${id}：已发送 Z，监测点赞结果`, "#fe2c55");
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

      if (!s.session || s.session.id !== id) {
        AutoLike.createSession(id);
      }

      AutoLike.attachVideoEvents(video);

      const session = s.session;

      if (session.cancelled) return;
      if (session.triggered) return;

      // 计时器存活或处于后台冻结态时不重排程。
      if (session.pendingTimer || session.frozenRemaining !== null) return;

      if (!Platform.isPlaying(video)) return;

      const state = Platform.getLikeState(likeButton);
      if (state === "UNKNOWN") return;

      if (state === "LIKED") {
        session.triggered = true;
        s.triggeredIds.add(id);

        UI.setStatus(`视频 ${id}：已经点赞，跳过`, "#fe2c55");
        return;
      }

      const delay =
        video.duration > 0 && video.duration < CONFIG.timing.likeMs / 1000
          ? CONFIG.timing.likeShortMs
          : CONFIG.timing.likeMs;

      session.pendingUntil = Date.now() + delay;
      session.pendingTimer = setTimeout(() => AutoLike.fireAutoLike(id), delay);

      UI.setStatus(`视频 ${id}：${delay / 1000} 秒后自动点赞`);
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
      if (!ctx || ctx.id !== s.session.id) return;

      const button = ctx.likeButton;
      if (!button || Platform.getLikeState(button) !== "LIKED") return;

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

        if (!isZ && !isButtonKey) return;
        if (event.repeat) return;
      } else {
        const target = event.target;

        if (!(target instanceof Element)) return;
        if (target.closest(CONFIG.platform.like) !== button) return;
      }

      s.manualAction = {
        id: ctx.id,
        button,
        time: performance.now(),
      };
    },

    handleLikeMutation(mutation, target) {
      const s = AppState;
      if (!s.running || !s.session) return;

      const oldState = mutation.oldValue;
      const newState = target.getAttribute("data-e2e-state");

      const ctx = Platform.getCurrentVideo();
      if (!ctx || ctx.id !== s.session.id || ctx.likeButton !== target) return;

      const session = s.session;

      if (
        oldState === CONFIG.platform.stateUnliked &&
        newState === CONFIG.platform.stateLiked &&
        session.autoLikeRequested
      ) {
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
        s.manualAction &&
        s.manualAction.id === ctx.id &&
        s.manualAction.button === target &&
        performance.now() - s.manualAction.time <
        CONFIG.timing.manualActionWindowMs
      ) {
        session.cancelled = true;
        session.autoLiked = false;

        // 滑走再滑回视为新观看，取消点赞后可以重新触发自动点赞。
        s.triggeredIds.delete(ctx.id);
        s.manualAction = null;

        UI.setStatus(`视频 ${ctx.id}：检测到手动取消点赞`, "#999");
        UI.updateUI();
      }
    },

    onVisibilityChange() {
      const s = AppState;

      if (document.hidden) {
        if (s.session?.pendingTimer) {
          clearTimeout(s.session.pendingTimer);
          s.session.pendingTimer = null;
          s.session.frozenRemaining = Math.max(
            0,
            s.session.pendingUntil - Date.now(),
          );
        }
        return;
      }

      // 恢复后台冻结的计时器，继续点赞。
      if (s.session && s.session.frozenRemaining !== null) {
        const id = s.session.id;
        const remaining = s.session.frozenRemaining;

        s.session.pendingUntil = Date.now() + remaining;
        s.session.pendingTimer = setTimeout(
          () => AutoLike.fireAutoLike(id),
          remaining,
        );
        s.session.frozenRemaining = null;
      }

      AutoLike.process();
    },

    setRunning(value) {
      AppState.running = value;

      if (!value && AppState.session?.pendingTimer) {
        clearTimeout(AppState.session.pendingTimer);
        AppState.session.pendingTimer = null;
      }

      UI.updateUI();
      AutoLike.process();
    },
  };

  /* ================================================================
   * §5 SLEEP TIMER — 睡眠定时器，播放一段时间后暂停视频
   * ================================================================ */

  const SleepTimer = {
    remainingMs() {
      const { endAt } = AppState.timer;
      return endAt === 0 ? 0 : Math.max(0, endAt - Date.now());
    },

    stop() {
      const t = AppState.timer;

      clearTimeout(t.timeoutId);
      clearInterval(t.tickId);

      t.timeoutId = null;
      t.tickId = null;
      t.endAt = 0;
    },

    start(minutes) {
      SleepTimer.stop();

      const t = AppState.timer;
      t.endAt = Date.now() + minutes * 60_000;
      t.timeoutId = setTimeout(
        () => SleepTimer.finish(),
        SleepTimer.remainingMs(),
      );
      t.tickId = setInterval(
        () => SleepTimer.onTick(),
        CONFIG.timing.playbackTickMs,
      );

      UI.updateTimerUI();
      SleepTimer.onTick();
    },

    onTick() {
      if (AppState.timer.endAt === 0) return;

      const ms = SleepTimer.remainingMs();
      UI.setTimerStatus(
        ms === 0 ? "正在暂停…" : `剩余 ${formatRemaining(ms)}`,
      );
    },

    finish() {
      if (AppState.timer.endAt === 0) return;

      SleepTimer.stop();
      UI.updateTimerUI();

      const ctx = Platform.getCurrentVideo();

      if (!ctx) {
        UI.setTimerStatus("未能定位当前视频");
        return;
      }

      ctx.video.pause();
      UI.setTimerStatus("定时结束");
    },

    onVisibilityChange() {
      if (document.hidden || AppState.timer.endAt === 0) return;

      if (SleepTimer.remainingMs() === 0) {
        SleepTimer.finish();
      } else {
        SleepTimer.onTick();
      }
    },
  };

  /* ================================================================
   * §6 UI & PANEL — 面板 DOM、样式与全部指针/点击事件
   * 事件一律经 on() 注册，保证 abort 时可回收。
   * ================================================================ */

  const UI = {
    el: {},

    css: `
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
      background: #41ff6a;
    }

    .dy-switch input:checked + .dy-slider:before {
      transform: translateX(18px);
    }

    #dy-close {
      cursor: pointer;
      opacity: .7;
    }
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
        <label class="dy-switch">
          <input id="dy-toggle" type="checkbox" checked>
          <span class="dy-slider"></span>
        </label>
      </div>

      <div class="dy-row">
        <span>睡眠定时</span>
      </div>

      <fieldset id="dy-timer-controls">
        <div class="dy-row">
          <button type="button" data-minutes="10">10 分钟</button>
          <button type="button" data-minutes="15">15 分钟</button>
          <button type="button" data-minutes="30">30 分钟</button>
        </div>

        <div class="dy-row">
          <button type="button" data-minutes="45">45 分钟</button>
          <button type="button" data-minutes="60">1 小时</button>
          <button type="button" data-minutes="120">2 小时</button>
        </div>

        <div class="dy-row">
          <input id="dy-timer-hours" type="number" min="0" value="0">
          <span>小时</span>
          <span>:</span>
          <input id="dy-timer-minutes" type="number" min="0" value="0">
          <span>分钟</span>
        </div>

        <div class="dy-row">
          <button id="dy-timer-custom" type="button">自定义时长</button>
        </div>
      </fieldset>

      <div class="dy-row">
        <span id="dy-timer-status">未启动</span>
        <button id="dy-timer-toggle" type="button" hidden>取消</button>
      </div>
    </div>
  `,

    mount() {
      GM_addStyle(UI.css);

      const panel = document.createElement("div");
      panel.id = "dy-panel";
      panel.innerHTML = UI.html;

      document.body.appendChild(panel);
      panel.classList.add("collapsed");
      Runtime.panel = panel;

      const $ = (selector) => panel.querySelector(selector);
      UI.el = {
        panel,
        status: $("#dy-status"),
        video: $("#dy-video"),
        count: $("#dy-count"),
        title: $("#dy-title"),
        dot: $("#dy-dot"),
        toggle: $("#dy-toggle"),
        timerControls: $("#dy-timer-controls"),
        timerHours: $("#dy-timer-hours"),
        timerMinutes: $("#dy-timer-minutes"),
        timerCustom: $("#dy-timer-custom"),
        timerCancel: $("#dy-timer-toggle"),
        timerStatus: $("#dy-timer-status"),
        close: $("#dy-close"),
        header: $("#dy-header"),
      };
    },

    contains(node) {
      const panel = Runtime.panel;
      return Boolean(node && (node === panel || panel.contains(node)));
    },

    setStatus(message, color = "#f5a623") {
      if (message === AppState.lastStatus && color === AppState.lastColor) {
        return;
      }

      AppState.lastStatus = message;
      AppState.lastColor = color;

      UI.el.status.textContent = message;
      UI.el.status.style.color = color;
    },

    setVideoId(id) {
      UI.el.video.textContent = `当前视频ID：${id}`;
    },

    setTimerStatus(message) {
      UI.el.timerStatus.textContent = message;
    },

    updateTimerUI() {
      const active = AppState.timer.endAt !== 0;

      UI.el.timerControls.disabled = active;
      UI.el.timerCancel.hidden = !active;
    },

    updateUI() {
      const s = AppState;
      const el = UI.el;

      el.dot.style.background = s.running ? "#2ecc71" : "#ff4d4f";
      el.toggle.checked = s.running;
      el.title.textContent = s.collapsed
        ? s.running
          ? "运行中"
          : "暂停中"
        : "自动点赞脚本";
      el.count.textContent = `今日累计刷视频${Records.getCount()}`;
    },

    setCollapsed(value) {
      AppState.collapsed = value;
      Runtime.panel.classList.toggle("collapsed", value);
      UI.updateUI();
    },

    resetPress() {
      if (!AppState.press) return;

      clearTimeout(AppState.press.timer);
      AppState.press = null;
    },

    onHeaderDown(event) {
      if (event.target.closest("#dy-close")) return;

      const rect = Runtime.panel.getBoundingClientRect();

      AppState.press = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
        timer: setTimeout(() => {
          AppState.press = null;

          if (AppState.collapsed) {
            UI.setCollapsed(false);
          }
        }, CONFIG.timing.longPressMs),
      };

      event.preventDefault();
    },

    onPointerMove(event) {
      const press = AppState.press;
      if (!press || event.pointerId !== press.pointerId) return;

      if (!press.moved) {
        const dx = event.clientX - press.x;
        const dy = event.clientY - press.y;

        if (Math.hypot(dx, dy) < CONFIG.timing.dragThresholdPx) return;

        press.moved = true;
        clearTimeout(press.timer);
      }

      Runtime.panel.style.left = `${press.left + event.clientX - press.x}px`;
      Runtime.panel.style.top = `${press.top + event.clientY - press.y}px`;
      Runtime.panel.style.right = "auto";
      Runtime.panel.style.bottom = "auto";
    },

    onPointerEnd(event) {
      if (!AppState.press || event.pointerId !== AppState.press.pointerId) {
        return;
      }
      UI.resetPress();
    },

    bindEvents() {
      const el = UI.el;

      on(el.toggle, "change", () => AutoLike.setRunning(el.toggle.checked));

      on(el.timerControls, "click", (event) => {
        const button = event.target.closest("[data-minutes]");
        if (button) SleepTimer.start(Number(button.dataset.minutes));
      });

      on(el.timerCustom, "click", () => {
        const minutes = parseDuration(
          el.timerHours.valueAsNumber,
          el.timerMinutes.valueAsNumber,
        );

        if (minutes === null) {
          UI.setTimerStatus("请设置大于 0 的时长");
          return;
        }

        SleepTimer.start(minutes);
      });

      on(el.timerCancel, "click", () => {
        SleepTimer.stop();
        UI.updateTimerUI();
        UI.setTimerStatus("已取消");
      });

      on(el.close, "click", () => UI.setCollapsed(true));
      on(el.header, "pointerdown", UI.onHeaderDown);

      on(document, "pointermove", UI.onPointerMove);
      on(document, "pointerup", UI.onPointerEnd);
      on(document, "pointercancel", UI.onPointerEnd);
    },
  };

  /* ================================================================
   * 唯一的组装点：观察者、路由钩子、全局监听、启动
   * ================================================================ */

  function getMutationTarget(mutation) {
    return mutation.target.nodeType === 1
      ? mutation.target
      : mutation.target.parentElement;
  }

  function onRouteChange() {
    AppState.manualAction = null;
    AutoLike.scheduleProcess();
  }

  // 页面可见性变化时，处理自动点赞和休眠计时器
  function onVisibilityChange() {
    AutoLike.onVisibilityChange();
    SleepTimer.onVisibilityChange();
  }

  function installObservers() {
    // 结构变化：视频切换、弹层打开关闭、DOM 节点增删等。
    observe(document.body, { childList: true, subtree: true }, (mutations) => {
      if (
        mutations.some((mutation) => !UI.contains(getMutationTarget(mutation)))
      ) {
        AutoLike.scheduleProcess();
      }
    });

    observe(
      document.body,
      {
        attributes: true,
        subtree: true,
        attributeOldValue: true,
        attributeFilter: ["data-e2e", "data-e2e-state", "data-e2e-vid"],
      },
      (mutations) => {
        let shouldProcess = false;

        for (const mutation of mutations) {
          const target = getMutationTarget(mutation);

          if (!target || UI.contains(target)) continue;

          if (
            mutation.attributeName === "data-e2e-state" &&
            target.matches(CONFIG.platform.like)
          ) {
            AutoLike.handleLikeMutation(mutation, target);
          }

          shouldProcess = true;
        }

        if (shouldProcess) AutoLike.scheduleProcess();
      },
    );
  }

  function installRouteHooks() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    const wrap = (original) =>
      function (...args) {
        const result = original.apply(this, args);
        onRouteChange();
        return result;
      };

    history.pushState = wrap(originalPushState);
    history.replaceState = wrap(originalReplaceState);
    on(window, "popstate", onRouteChange);

    // 卸载时恢复原始方法，避免污染全局 history 对象
    onDispose(() => {
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
    });
  }

  function installGlobalListeners() {
    on(document, "pointerdown", AutoLike.markManualAction, { capture: true });
    on(document, "keydown", AutoLike.markManualAction, { capture: true });
    on(document, "visibilitychange", onVisibilityChange);
  }

  function registerCleanup() {
    onDispose(() => clearTimeout(AppState.session?.pendingTimer));
    onDispose(() => SleepTimer.stop());
  }

  UI.mount();
  UI.bindEvents();
  installObservers();
  installRouteHooks();
  installGlobalListeners();
  registerCleanup();
  Records.registerMenu();

  Records.save();
  UI.updateUI();
  AutoLike.process();
})();
