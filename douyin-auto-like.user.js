// ==UserScript==
// @name         抖音推荐流 · 自动点赞（Z 键通道）
// @version      1.0.0
// @description  刷推荐流时按视频停留随机秒数后自动点赞。面板显示今日刷数、自动点赞数与当前视频赞态。
// @author       阿鲲
// @match        https://www.douyin.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/<用户>/<仓库>/main/douyin-auto-like.user.js
// @downloadURL  https://raw.githubusercontent.com/<用户>/<仓库>/main/douyin-auto-like.user.js
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'dyAutoLike:cfg';
  const DAY_KEY = 'dyAutoLike:day';
  const cfg = Object.assign({ enabled: true, dwellMinMs: 3000, dwellMaxMs: 8000 }, GM_getValue(STORE_KEY, {}));
  const save = () => GM_setValue(STORE_KEY, cfg);
  const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  // 今日计数：跨刷新保留，跨天归零
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  const old = GM_getValue(DAY_KEY, null);
  const day = (old && old.d === today()) ? old : { d: today(), n: 0, like: 0 };

  const s = {
    vid: '', timer: 0, index: day.n, likes: day.like || 0, pending: '',
    seen: new Set(), tracked: new Set(), counted: new Set(),
    now: '未赞', why: ''
  };

  const getActive = () => document.querySelector('[data-e2e="feed-active-video"]');

  const getVid = () => {
    const active = getActive();
    if (!active) return '';
    return active.getAttribute('data-e2e-vid') || active.querySelector('video')?.src || '';
  };

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

  const setWhy = (msg) => { s.why = msg; render(); };

  // 待处理视频由 pending 表达：暂停只撤定时器不撤任务，恢复后仍是同一视频就重新排
  const schedule = () => {
    clearTimeout(s.timer);
    s.timer = 0;
    if (!cfg.enabled || !s.pending) return;
    s.timer = setTimeout(() => {
      const vid = s.pending;
      if (getVid() !== vid) return;
      const cur = readLike();
      if (cur === true) return setWhy('');
      if (cur === null) return setWhy('读不到点赞状态');
      s.pending = '';
      s.tracked.add(vid);
      press('z', 'KeyZ', 90);
    }, rand(cfg.dwellMinMs, cfg.dwellMaxMs));
  };

  const toggle = () => {
    cfg.enabled = !cfg.enabled;
    save();
    schedule();
    render();
  };

  const tick = () => {
    const vid = getVid();
    if (!vid) return;

    const liked = readLike();

    // 脚本派发的视频观测到已赞，才算一次自动点赞
    if (liked === true && s.tracked.has(vid) && !s.counted.has(vid)) {
      s.counted.add(vid);
      s.likes++;
      day.like = s.likes;
      GM_setValue(DAY_KEY, day);
    }

    s.now = liked === true ? '已赞' : (liked === null ? '未知' : '未赞');

    if (!cfg.enabled) return setWhy('');
    if (vid === s.vid) return render();

    s.vid = vid;

    s.pending = s.seen.has(vid) ? '' : vid;
    s.why = s.pending ? '' : '重复视频';

    if (s.pending) {
      s.seen.add(vid);
      s.index++;
      day.n = s.index;
      GM_setValue(DAY_KEY, day);
    }

    schedule();
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
    #dy-al{position:fixed;right:16px;bottom:16px;z-index:999999;width:200px;background:rgba(20,22,26,.9);backdrop-filter:blur(14px) saturate(150%);color:#e8eaed;border:1px solid rgba(255,255,255,.09);border-radius:14px;font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.2px;box-shadow:0 10px 30px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.04);user-select:none}
    #dy-al.min .body{display:none}
    .head{display:flex;align-items:center;gap:7px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.07);font-weight:500;cursor:pointer}
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
  panel.className = 'min';
  panel.innerHTML = `
    <div class="head"><i class="dot"></i>自动点赞<u data-f="btn">暂停</u><b>+</b></div>
    <div class="body">
      <div class="row"><b data-f="index">今天已刷 0 个视频</b></div>
      <div class="row"><span>今日自动赞</span><b data-f="likes">0</b></div>
      <div class="row"><span>本视频</span><b data-f="now">未赞</b></div>
      <div class="row" data-f="whyRow" style="display:none"><span>未赞原因</span><b data-f="why"></b></div>
      <div class="tip">Alt+Z 暂停 / 继续</div>
    </div>`;
  document.body.appendChild(panel);

  panel.querySelector('.head').addEventListener('click', () => {
    panel.classList.toggle('min');
    panel.querySelector('.head b').textContent = panel.classList.contains('min') ? '+' : '−';
  });

  panel.querySelector('[data-f="btn"]').addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });

  const TONE = { ok: '#7ee787', warn: '#f2cc60', mute: '#9aa0a6' };

  function render() {
    panel.querySelector('[data-f="index"]').textContent = `今天已刷 ${s.index} 个视频`;
    panel.querySelector('[data-f="likes"]').textContent = s.likes;

    const now = panel.querySelector('[data-f="now"]');
    now.textContent = s.now;
    now.style.color = s.now === '已赞' ? TONE.ok : (s.why ? TONE.warn : TONE.mute);

    panel.querySelector('[data-f="whyRow"]').style.display = s.why ? 'flex' : 'none';
    panel.querySelector('[data-f="why"]').textContent = s.why;
    panel.querySelector('[data-f="why"]').style.color = TONE.warn;

    panel.querySelector('.dot').classList.toggle('off', !cfg.enabled);
    panel.querySelector('[data-f="btn"]').textContent = cfg.enabled ? '暂停' : '继续';
  }

  render();
  setInterval(tick, 400);
})();
