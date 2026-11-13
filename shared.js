(function (exports) {
  const CONFIG = {
    width: 800,
    height: 600,
    playerRadius: 16,
    coinRadius: 8,
    spawnerRadius: 28,
    coinCount: 5,
    speed: 220,
    winScore: 20,
    stepSeconds: 1 / 60,
    dashTicks: 8,
    dashDistance: 16 * 2 * 3,
    dashCoinCost: 5,
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const clampToArena = (position, radius) => {
    position.x = clamp(position.x, radius, CONFIG.width - radius);
    position.y = clamp(position.y, radius, CONFIG.height - radius);
  };

  const moveBy = (position, dx, dy) => {
    position.x += dx;
    position.y += dy;
    clampToArena(position, CONFIG.playerRadius);
  };

  const canDash = (state) => state.dashTicks === 0 && state.dashCharge >= CONFIG.dashCoinCost;

  const applyInput = (state, keys) => {
    const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    const length = Math.hypot(dx, dy) || 1;
    if (dx || dy) {
      state.faceX = dx / length;
      state.faceY = dy / length;
    }
    if (keys.dash && canDash(state)) {
      state.dashCharge = 0;
      state.dashTicks = CONFIG.dashTicks;
      state.dashX = state.faceX;
      state.dashY = state.faceY;
    }
    if (state.dashTicks > 0) {
      state.dashTicks -= 1;
      const dashStep = CONFIG.dashDistance / CONFIG.dashTicks;
      moveBy(state, state.dashX * dashStep, state.dashY * dashStep);
      return;
    }
    const distance = CONFIG.speed * CONFIG.stepSeconds;
    moveBy(state, (dx / length) * distance, (dy / length) * distance);
  };

  exports.CONFIG = CONFIG;
  exports.applyInput = applyInput;
  exports.moveBy = moveBy;
  exports.clampToArena = clampToArena;
})(typeof module === "undefined" ? (window.Shared = {}) : module.exports);
