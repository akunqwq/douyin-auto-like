  const UI = {
    el: {},
    css: `__PANEL_CSS__`,
    html: `__PANEL_HTML__`,

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
        title: $("#dy-title"), timerControls: $("#dy-timer-controls"), timerHours: $("#dy-timer-hours"),
        timerMinutes: $("#dy-timer-minutes"), timerCustom: $("#dy-timer-custom"),
        timerCancel: $("#dy-timer-toggle"), timerStatus: $("#dy-timer-status"),
        close: $("#dy-close"), header: $("#dy-header"),
      };

      UI.el.status.textContent = AppState.lastStatus || "未启动";
      UI.el.video.textContent = AppState.session?.id ?? "为空";
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

    setVideoId(id) {
      if (UI.el.video.textContent !== id) UI.el.video.textContent = id;
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
