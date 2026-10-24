// ==UserScript==
// @name         抖音推荐流 · 自动点赞（Z 键通道）
// @version      1.5.1
// @description  至少播放 3 秒，再结合视频时长随机等待；暂停或缓冲时冻结剩余时间，恢复后继续。
// @author       阿鲲
// @match        https://www.douyin.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/akunqwq/douyin-auto-like/main/douyin-auto-like.user.js
// @downloadURL  https://raw.githubusercontent.com/akunqwq/douyin-auto-like/main/douyin-auto-like.user.js
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'dyAutoLike:cfg';
  const DAY_KEY = 'dyAutoLike:day';
  const PANEL_KEY = 'dyAutoLike:panelVisible';
  let panelVisible = GM_getValue(PANEL_KEY, true) !== false;
  const cfg = Object.assign({ enabled: true, dwellMinMs: 3000, dwellMaxMs: 8000 }, GM_getValue(STORE_KEY, {}));
  const save = () => GM_setValue(STORE_KEY, cfg);
  const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  // 自适应等待：短视频缩短最低等待时间，目标不超过视频总时长的90%。
  const MIN_PLAY_MS = Math.max(3000, Number(cfg.dwellMinMs) || 3000);
  const MAX_DURATION_EXTRA_MS = 9000;
  const DURATION_EXTRA_RATIO = 0.25;

  // 今日计数：跨刷新保留，跨天归零
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  const old = GM_getValue(DAY_KEY, null);
  const day = (old && old.d === today()) ? old : { d: today(), n: 0, like: 0 };

  const s = {
    vid: '', index: day.n, likes: day.like || 0, pending: '', remainingMs: null,
    durationUnknownSince: 0, lastMediaTime: null, lastWallAt: 0,
    seen: new Set(), tracked: new Set(), counted: new Set(),
    now: '未赞', why: ''
  };

  const getActive = () => document.querySelector('[data-e2e="feed-active-video"]');
  const getVideo = () => getActive()?.querySelector('video') || null;

  const getVid = () => {
    const active = getActive();
    if (!active) return '';
    return active.getAttribute('data-e2e-vid') || active.querySelector('video')?.src || '';
  };

  const isVideoPlaying = (video) => !!video
    && !video.paused
    && !video.ended
    && !video.seeking
    && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;

  // 限定在活动视频内查点赞按钮：推荐流同时存在多个视频节点，全局查会读到别的视频
  const readLike = () => {
    const st = getActive()?.querySelector('[data-e2e="video-player-digg"]')?.getAttribute('data-e2e-state');
    return st === 'video-player-is-digged' ? true : (st?.includes('no-digged') ? false : null);
  };

  const press = (key, code, keyCode) => {
    const target = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : document.body;
    const init = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  };

  const resetPlaybackBaseline = () => {
    s.lastMediaTime = null;
    s.lastWallAt = 0;
  };

  // 倒计时归属当前 pending 视频，只在视频时间轴实际前进时扣减。
  // 目标等待时间：至少 3 秒 + 按视频时长随机增加 0%～25%，额外部分最多 9 秒。
  // 暂停、缓冲、切换视频或暂停脚本时均保留 remainingMs，不重新随机。
    const chooseWaitMs = (video) => {
    const durationMs = Math.floor(Number(video?.duration) * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) return null;

    const latestWaitMs = Math.floor(durationMs * 0.9 - video.currentTime * 1000);
    const minWaitMs = Math.min(MIN_PLAY_MS, Math.floor(durationMs * 0.6));

    if (latestWaitMs < minWaitMs) return -1;

    const maxExtraMs = Math.max(0, Math.min(
      Math.floor(durationMs * DURATION_EXTRA_RATIO),
      MAX_DURATION_EXTRA_MS,
      latestWaitMs - minWaitMs
    ));

    return minWaitMs + rand(0, maxExtraMs);
  };

  const clearTask = (why = '') => {
    s.pending = '';
    s.remainingMs = null;
    s.durationUnknownSince = 0;
    s.why = why;
    resetPlaybackBaseline();
  };

  // 统一处理计时初始化、暂停、累计播放时间和到期判断。
  const advanceCountdown = (vid) => {
    const video = getVideo();
    const now = performance.now();
    const mediaTime = video?.currentTime ?? null;

    if (s.pending && s.pending === vid && video?.ended && getVid() === vid) {
      clearTask(readLike() === true ? '' : '视频已结束，未触发');
      return false;
    }

    if (!s.pending || s.pending !== vid) {
      resetPlaybackBaseline();
      s.durationUnknownSince = 0;
      return false;
    }

    if (!cfg.enabled || getVid() !== s.pending || !isVideoPlaying(video)) {
      s.lastMediaTime = mediaTime;
      s.lastWallAt = now;
      s.durationUnknownSince = 0;
      return false;
    }

    if (s.remainingMs === null) {
      const target = chooseWaitMs(video);

      if (target === -1) {
        clearTask('视频接近结束，跳过');
        return false;
      }

      if (target !== null) {
        s.remainingMs = target;
      } else {
        if (!s.durationUnknownSince) s.durationUnknownSince = now;

        if (now - s.durationUnknownSince < 2000) {
          s.lastMediaTime = mediaTime;
          s.lastWallAt = now;
          return false;
        }

        s.remainingMs = rand(cfg.dwellMinMs, cfg.dwellMaxMs);
      }

      s.durationUnknownSince = 0;
      s.lastMediaTime = mediaTime;
      s.lastWallAt = now;
      return false;
    }

    if (s.lastMediaTime !== null && s.lastWallAt > 0) {
      const delta = mediaTime - s.lastMediaTime;
      const maxDelta = Math.max(0.75, ((now - s.lastWallAt) / 1000) * 2.5);

      if (delta > 0 && delta <= maxDelta) {
        s.remainingMs = Math.max(0, s.remainingMs - delta * 1000);
      }
    }

    s.lastMediaTime = mediaTime;
    s.lastWallAt = now;
    return s.remainingMs <= 0;
  };

   const tryAutoLike = (vid) => {
    // 最后复核当前视频、运行状态及点赞状态。
    if (!cfg.enabled || !s.pending || s.pending !== vid || getVid() !== vid) return;
    if (!isVideoPlaying(getVideo())) return;

    const cur = readLike();

    if (cur === null) {
      s.why = '读不到点赞状态';
      return;
    }

    if (cur === true) {
      clearTask();
      return;
    }

    // 先清除任务，再派发按键，避免重复触发。
    clearTask();
    s.tracked.add(vid);
    press('z', 'KeyZ', 90);
  };

  const toggle = () => {
    cfg.enabled = !cfg.enabled;
    save();
    // 不重置 remainingMs：通过快捷键暂停脚本后恢复，也继续剩余倒计时。
    resetPlaybackBaseline();
    render();
  };

  const tick = () => {
    const vid = getVid();

    if (!vid) {
      advanceCountdown('');
      render();
      return;
    }

    const liked = readLike();

    if (liked === true && s.tracked.has(vid) && !s.counted.has(vid)) {
      s.counted.add(vid);
      s.likes++;
      day.like = s.likes;
      GM_setValue(DAY_KEY, day);
    }

    s.now = liked === true ? '已赞' : (liked === null ? '未知' : '未赞');

    // 脚本暂停时只冻结任务，不创建新任务。
    if (!cfg.enabled) {
      advanceCountdown(vid);
      s.why = '';
      render();
      return;
    }

    // 视频切换时只初始化一次任务。
    if (vid !== s.vid) {
      s.vid = vid;
      s.pending = s.seen.has(vid) ? '' : vid;
      s.remainingMs = null;
      s.durationUnknownSince = 0;
      resetPlaybackBaseline();
      s.why = s.pending ? '' : '重复视频';

      if (s.pending) {
        s.seen.add(vid);
        s.index++;
        day.n = s.index;
        GM_setValue(DAY_KEY, day);
      }
    }

    if (advanceCountdown(vid)) tryAutoLike(vid);
    render();
  };

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (e.altKey && e.code === 'KeyZ') {
      e.preventDefault();
      toggle();
    }
  }, true);

  // 面板样式
  GM_addStyle(`
    #dy-al{position:fixed;left:16px;top:16px;z-index:999999;width:200px;background:rgba(20,22,26,.9);backdrop-filter:blur(14px) saturate(150%);color:#e8eaed;border:1px solid rgba(255,255,255,.09);border-radius:14px;font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.2px;box-shadow:0 10px 30px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.04);user-select:none}
    .head{display:flex;align-items:center;gap:7px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.07);font-weight:500;cursor:move;touch-action:none;}
    .dot{width:7px;height:7px;border-radius:50%;background:#FE2C55;flex:none;box-shadow:0 0 0 3px rgba(254,44,85,.16)}
    .dot.off{background:#6b7280;box-shadow:0 0 0 3px rgba(107,114,128,.12)}
    .head b{margin-left:8px;font-weight:400;opacity:.45;font-size:13px}
    .head u{margin-left:auto;padding:1.5px 7px;border-radius:6px;background:rgba(255,255,255,.09);text-decoration:none;font-size:11px;opacity:.85}
    .head u:hover{background:rgba(255,255,255,.16)}
    .body{padding:8px 12px 9px}
    .row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:3.5px 0}
    .row span{opacity:.5;font-size:11.5px;flex:none}
    .row b{font-weight:500;color:#8ab4f8;max-width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
    .tip{margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.07);opacity:.4;font-size:11px}
  `);

  const panel = document.createElement('div');
  panel.id = 'dy-al';
  panel.innerHTML = `
    <div class="head">
    <i class="dot"></i>
    自动点赞
    <button type="button" data-f="btn">暂停</button>
    </div>
    <div class="body">
      <div class="row"><b data-f="index">今天已刷 0 个视频</b></div>
      <div class="row"><span>今日自动赞</span><b data-f="likes">0</b></div>
      <div class="row"><span>本视频</span><b data-f="now">未赞</b></div>
      <div class="row"><span>播放倒计时</span><b data-f="countdown">等待视频</b></div>
      <div class="row" data-f="whyRow" style="display:none"><span>提示</span><b data-f="why"></b></div>
      <div class="tip">Alt+Z 暂停 / 继续</div>
    </div>`;
  document.body.appendChild(panel);
   // 拖动标题栏移动面板，不影响暂停按钮点击。
  const head = panel.querySelector('.head');
  let dragState = null;

  head.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0 || e.target.closest('button')) return;

    const rect = panel.getBoundingClientRect();

    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: rect.left,
      top: rect.top
    };

    // 将原本的右下角定位转换为左上角定位。
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';

    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  head.addEventListener('pointermove', (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);

    const left = dragState.left + e.clientX - dragState.startX;
    const top = dragState.top + e.clientY - dragState.startY;

    panel.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
  });

  const endDrag = (e) => {
    if (dragState?.pointerId === e.pointerId) {
      dragState = null;
    }
  };

  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  panel.querySelector('[data-f="btn"]').addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });

  const togglePanelVisibility = () => {
  panelVisible = !panelVisible;
  GM_setValue(PANEL_KEY, panelVisible);
  panel.style.display = panelVisible ? '' : 'none';
};

const showTodayStats = () => {
  alert(
    `抖音自动点赞\n` +
    `运行状态：${cfg.enabled ? '运行中' : '已暂停'}\n` +
    `今日刷视频：${s.index}\n` +
    `今日自动点赞：${s.likes}`
  );
};

GM_registerMenuCommand('自动点赞：暂停 / 继续', toggle);
GM_registerMenuCommand('自动点赞：显示 / 隐藏页面面板', togglePanelVisibility);
GM_registerMenuCommand('自动点赞：查看今日统计', showTodayStats);

  const TONE = { ok: '#7ee787', warn: '#f2cc60', mute: '#9aa0a6' };

  function render() {
    panel.style.display = panelVisible ? '' : 'none';
    panel.querySelector('[data-f="index"]').textContent = `今天已刷 ${s.index} 个视频`;
    panel.querySelector('[data-f="likes"]').textContent = s.likes;

    const now = panel.querySelector('[data-f="now"]');
    now.textContent = s.now;
    now.style.color = s.now === '已赞' ? TONE.ok : (s.why ? TONE.warn : TONE.mute);

    const countdown = panel.querySelector('[data-f="countdown"]');
    if (!s.pending) {
      countdown.textContent = s.why === '重复视频' ? '已看过' : (s.now === '已赞' ? '已完成' : '—');
    } else {
      const video = getVideo();
      if (s.remainingMs === null) {
        if (!cfg.enabled) countdown.textContent = '脚本暂停 · 等待初始化';
        else if (getVid() !== s.pending || !isVideoPlaying(video)) countdown.textContent = '等待播放';
        else countdown.textContent = '读取时长…';
      } else {
        const seconds = (Math.max(0, s.remainingMs) / 1000).toFixed(1);
        if (!cfg.enabled) countdown.textContent = `脚本暂停 · ${seconds}s`;
        else if (getVid() !== s.pending || !isVideoPlaying(video)) countdown.textContent = `暂停中 · ${seconds}s`;
        else countdown.textContent = `${seconds}s`;
      }
    }

    panel.querySelector('[data-f="whyRow"]').style.display = s.why ? 'flex' : 'none';
    panel.querySelector('[data-f="why"]').textContent = s.why;
    panel.querySelector('[data-f="why"]').style.color = TONE.warn;

    panel.querySelector('.dot').classList.toggle('off', !cfg.enabled);
    panel.querySelector('[data-f="btn"]').textContent = cfg.enabled ? '暂停' : '继续';
  }

  render();
  // 一个统一轮询：切换视频、读取赞态与推进播放倒计时，避免多个定时器互相重置任务。
  setInterval(tick, 100);
})();
