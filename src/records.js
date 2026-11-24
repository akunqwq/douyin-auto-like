  const Records = {
    rolloverIfNeeded() {
      const now = formatDate(new Date());
      if (now === AppState.today) return;

      AppState.today = now;
      AppState.records = Object.create(null);
      AppState.cancelled = Object.create(null);
      AppState.triggeredIds.clear();
      AppState.session = null;
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

    cancel(id) {
      Records.rolloverIfNeeded();
      if (AppState.cancelled[id]) return;
      AppState.cancelled[id] = true;
      Records.save();
    },

    export() {
      Records.rolloverIfNeeded();
      const ids = Object.keys(AppState.records);
      if (!ids.length) {
        GM_notification({ title: "抖音自动点赞", text: "今日暂无可导出的记录" });
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
