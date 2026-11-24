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
