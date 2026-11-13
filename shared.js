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
    hardHitThreshold: 0.5,
    walls: [
      { x: 150, y: 120, w: 140, h: 24 },
      { x: 510, y: 120, w: 140, h: 24 },
      { x: 150, y: 456, w: 140, h: 24 },
      { x: 510, y: 456, w: 140, h: 24 },
      { x: 388, y: 250, w: 24, h: 100 },
      { x: 70, y: 260, w: 24, h: 80 },
      { x: 706, y: 260, w: 24, h: 80 },
    ],
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const escapeFromInside = (position, radius, rect) => {
    const exits = [
      { distance: position.x - rect.x, x: -1, y: 0 },
      { distance: rect.x + rect.w - position.x, x: 1, y: 0 },
      { distance: position.y - rect.y, x: 0, y: -1 },
      { distance: rect.y + rect.h - position.y, x: 0, y: 1 },
    ];
    const exit = exits.reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best));
    position.x += exit.x * (exit.distance + radius);
    position.y += exit.y * (exit.distance + radius);
    return exit;
  };

  const pushOutOfRect = (position, radius, rect) => {
    const nearestX = clamp(position.x, rect.x, rect.x + rect.w);
    const nearestY = clamp(position.y, rect.y, rect.y + rect.h);
    const dx = position.x - nearestX;
    const dy = position.y - nearestY;
    const distance = Math.hypot(dx, dy);
    if (distance >= radius) return null;
    if (distance === 0) return escapeFromInside(position, radius, rect);
    const normal = { x: dx / distance, y: dy / distance };
    position.x = nearestX + normal.x * radius;
    position.y = nearestY + normal.y * radius;
    return normal;
  };

  const resolveWalls = (position, radius) => {
    let normalX = 0;
    let normalY = 0;
    if (position.x < radius) normalX += 1;
    if (position.x > CONFIG.width - radius) normalX -= 1;
    if (position.y < radius) normalY += 1;
    if (position.y > CONFIG.height - radius) normalY -= 1;
    position.x = clamp(position.x, radius, CONFIG.width - radius);
    position.y = clamp(position.y, radius, CONFIG.height - radius);
    for (const wall of CONFIG.walls) {
      const normal = pushOutOfRect(position, radius, wall);
      if (!normal) continue;
      normalX += normal.x;
      normalY += normal.y;
    }
    const length = Math.hypot(normalX, normalY);
    return length ? { x: normalX / length, y: normalY / length } : null;
  };

  const moveBy = (position, dx, dy) => {
    position.x += dx;
    position.y += dy;
    return resolveWalls(position, CONFIG.playerRadius);
  };

  const isHardHit = (normal, directionX, directionY) =>
    Boolean(normal) && normal.x * directionX + normal.y * directionY < -CONFIG.hardHitThreshold;

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
      const wallNormal = moveBy(state, state.dashX * dashStep, state.dashY * dashStep);
      if (!isHardHit(wallNormal, state.dashX, state.dashY)) return false;
      state.dashTicks = 0;
      return true;
    }
    const distance = CONFIG.speed * CONFIG.stepSeconds;
    moveBy(state, (dx / length) * distance, (dy / length) * distance);
    return false;
  };

  exports.CONFIG = CONFIG;
  exports.applyInput = applyInput;
  exports.moveBy = moveBy;
  exports.resolveWalls = resolveWalls;
  exports.isHardHit = isHardHit;
})(typeof module === "undefined" ? (window.Shared = {}) : module.exports);
