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
      if (!session || session.cancelled || s.cancelled[session.id] || session.triggered || document.hidden) return;

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
        watchedSec: 0,
        lastTime: null,
      };
      Records.record(id);
    },

    fireAutoLike(id) {
      const session = AppState.session;
      if (!session || session.id !== id || session.cancelled || AppState.cancelled[id] || session.triggered) return;

      const ctx = Platform.getCurrentVideo();
      if (!ctx || ctx.id !== id || !Platform.isPlaying(ctx.video)) return;

      if (Platform.getLikeState(ctx.likeButton) === "LIKED") {
        session.triggered = true;
        AppState.triggeredIds.add(id);
        UI.setStatus(`视频 ${id}：已点赞，跳过自动点赞`, "#fe2c55");
        return;
      }

      session.triggered = true;
      session.autoLikeRequested = true;
      AppState.triggeredIds.add(id);
      AutoLike.pressZ();
      UI.setStatus(`视频 ${id}：已发送 Z，等待确认`, "#fe2c55");

      setTimeout(() => {
        if (AppState.session !== session || !session.autoLikeRequested) return;
        session.autoLikeRequested = false;
        const current = Platform.getCurrentVideo();
        if (!current || current.id !== id) return;
        if (Platform.getLikeState(current.likeButton) === "LIKED") {
          UI.setStatus(`视频 ${id}：已点赞`, "#fe2c55");
          UI.updateUI();
        } else {
          UI.setStatus(`视频 ${id}：未确认到点赞，请手动点赞`, "#f5a623");
        }
      }, CONFIG.timing.confirmWindowMs);
    },

    process() {
      const s = AppState;
      Records.rolloverIfNeeded();

      if (document.hidden) return;

      const ctx = Platform.getCurrentVideo();
      if (!ctx) return;

      const { id, video } = ctx;
      UI.setVideoId(id);

      if (s.cancelled[id]) {
        if (s.session?.id === id) {
          s.session.cancelled = true;
          s.session.autoLikeRequested = false;
        }
        UI.setStatus(`视频 ${id}：已手动取消，今日不再处理该视频`, "#999");
        return;
      }

      if (!s.session || s.session.id !== id) AutoLike.createSession(id);
      AutoLike.attachVideoEvents(video);

      const session = s.session;
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
      const delay = Math.max(0, 200 - (performance.now() - AppState.lastProcessAt));
      AppState.frame = setTimeout(() => {
        AppState.frame = 0;
        AppState.lastProcessAt = performance.now();
        AutoLike.process();
      }, delay);
    },

    handleLikeMutation(mutation, target) {
      Records.rolloverIfNeeded();

      const s = AppState;
      if (!s.session) return;

      const session = s.session;
      const oldState = mutation.oldValue;
      const newState = target.getAttribute("data-e2e-state");
      const ctx = Platform.getCurrentVideo();
      if (!ctx || ctx.id !== session.id || s.cancelled[ctx.id]) return;

      if (oldState === CONFIG.platform.stateUnliked && newState === CONFIG.platform.stateLiked && session.autoLikeRequested) {
        session.autoLikeRequested = false;
        UI.setStatus(`视频 ${ctx.id}：已点赞`, "#fe2c55");
        UI.updateUI();
        return;
      }

      if (oldState === CONFIG.platform.stateLiked && newState === CONFIG.platform.stateUnliked) {
        session.cancelled = true;
        session.autoLikeRequested = false;
        s.triggeredIds.delete(ctx.id);
        Records.cancel(ctx.id);
        UI.setStatus(`视频 ${ctx.id}：已手动取消，今日不再处理该视频`, "#999");
        UI.updateUI();
      }
    },
  };
