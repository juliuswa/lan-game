(function (exports) {
  const CONFIG = {
    width: 800,
    height: 600,
    playerRadius: 16,
    coinRadius: 8,
    coinCount: 5,
    speed: 220,
    winScore: 20,
    stepSeconds: 1 / 60,
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const applyInput = (position, keys) => {
    const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    const length = Math.hypot(dx, dy) || 1;
    const distance = CONFIG.speed * CONFIG.stepSeconds;
    position.x = clamp(position.x + (dx / length) * distance, CONFIG.playerRadius, CONFIG.width - CONFIG.playerRadius);
    position.y = clamp(position.y + (dy / length) * distance, CONFIG.playerRadius, CONFIG.height - CONFIG.playerRadius);
  };

  exports.CONFIG = CONFIG;
  exports.applyInput = applyInput;
})(typeof module === "undefined" ? (window.Shared = {}) : module.exports);
