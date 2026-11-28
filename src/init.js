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
