  const Platform = {
    isPlaying: (video) => !video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,

    isLive: (player) => Boolean(player?.querySelector(CONFIG.platform.live)),

    findLikeButton: (box) => box?.querySelector(CONFIG.platform.playerDigg) || box?.querySelector(CONFIG.platform.feedDigg),

    getLikeState(button) {
      const state = button?.getAttribute("data-e2e-state");
      if (state === CONFIG.platform.stateLiked) return "LIKED";
      return "UNLIKED";
    },

    getVideoContext(player, allowLive = false) {
      if (!allowLive && Platform.isLive(player)) return null;
      const id = player.getAttribute("data-e2e-vid")?.trim();
      const video = player.querySelector("video");
      if (!id || !CONFIG.platform.vidPattern.test(id) || !video) return null;
      return { id, video, likeButton: Platform.findLikeButton(player) };
    },

    getCurrentVideo(allowLive = false) {
      let first = null;
      for (const player of document.querySelectorAll(CONFIG.platform.activePlayer)) {
        const ctx = Platform.getVideoContext(player, allowLive);
        if (!ctx) continue;
        if (!first) first = ctx;
        if (Platform.isPlaying(ctx.video)) return ctx;
      }
      return first;
    },
  };
