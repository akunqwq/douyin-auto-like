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
