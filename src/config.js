  const CONFIG = {
    STORAGE_KEY: "dy_auto_like_data",
    platform: {
      activePlayer: '[data-e2e="feed-active-video"][data-e2e-vid]',
      live: '[data-e2e="live-slider"]',
      playerDigg: '[data-e2e="video-player-digg"]',
      feedDigg: '[data-e2e="feed-digg"]',
      stateLiked: "video-player-is-digged",
      stateUnliked: "video-player-no-digged",
      vidPattern: /^\d+$/,
      videoEvents: ["playing", "play", "pause", "waiting", "stalled", "ended", "canplay", "loadeddata"],
    },
    timing: {
      likeMs: 10_000,
      likeShortMs: 3_000,
      maxStepSec: 1,
      confirmWindowMs: 2_000,
      playbackTickMs: 1_000,
      maxIdleMs: 4 * 60 * 60_000,
      longPressMs: 500,
      dragThresholdPx: 5,
    },
  };

  CONFIG.platform.like = `${CONFIG.platform.playerDigg}, ${CONFIG.platform.feedDigg}`;
