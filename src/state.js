  const AppState = {
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
    boundVideos: new WeakSet(),
    panel: null,
  };
