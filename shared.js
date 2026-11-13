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
    roundsToWin: 5,
    stepSeconds: 1 / 60,
    dashTicks: 8,
    dashDiameters: 3,
    dashCoinCost: 3,
    aimTurnSpeed: 4,
    aimSpeedFactor: 0.4,
    hardHitThreshold: 0.5,
  };

  const signedArea = (boundary) =>
    boundary.reduce((sum, [ax, ay], i) => {
      const [bx, by] = boundary[(i + 1) % boundary.length];
      return sum + ax * by - bx * ay;
    }, 0) / 2;

  const edgesOf = (boundary) => {
    const winding = Math.sign(signedArea(boundary)) || 1;
    return boundary.map(([ax, ay], i) => {
      const [bx, by] = boundary[(i + 1) % boundary.length];
      const length = Math.hypot(bx - ax, by - ay) || 1;
      return { ax, ay, bx, by, inwardX: (-(by - ay) / length) * winding, inwardY: ((bx - ax) / length) * winding };
    });
  };

  const RECTANGLE = [[0, 0], [CONFIG.width, 0], [CONFIG.width, CONFIG.height], [0, CONFIG.height]];

  let currentArena = { boundary: RECTANGLE, walls: [], edges: edgesOf(RECTANGLE) };

  const setArena = ({ boundary, walls }) => {
    if (currentArena.boundary !== boundary) currentArena = { boundary, walls, edges: edgesOf(boundary) };
    else currentArena.walls = walls;
  };

  const pointInPolygon = (point, boundary = currentArena.boundary) => {
    let inside = false;
    for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
      const [xi, yi] = boundary[i];
      const [xj, yj] = boundary[j];
      if (yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  const closestPointOnEdge = (point, edge) => {
    const ex = edge.bx - edge.ax;
    const ey = edge.by - edge.ay;
    const t = Math.max(0, Math.min(1, ((point.x - edge.ax) * ex + (point.y - edge.ay) * ey) / (ex * ex + ey * ey || 1)));
    return { x: edge.ax + ex * t, y: edge.ay + ey * t };
  };

  const distanceToBoundary = (point) =>
    Math.min(...currentArena.edges.map((edge) => {
      const closest = closestPointOnEdge(point, edge);
      return Math.hypot(point.x - closest.x, point.y - closest.y);
    }));

  const pullInside = (position, radius) => {
    let best = null;
    for (const edge of currentArena.edges) {
      const closest = closestPointOnEdge(position, edge);
      const distance = Math.hypot(position.x - closest.x, position.y - closest.y);
      if (!best || distance < best.distance) best = { distance, closest, edge };
    }
    position.x = best.closest.x + best.edge.inwardX * radius;
    position.y = best.closest.y + best.edge.inwardY * radius;
    return { x: best.edge.inwardX, y: best.edge.inwardY };
  };

  const resolveBoundary = (position, radius) => {
    if (!pointInPolygon(position)) return pullInside(position, radius);
    let normalX = 0;
    let normalY = 0;
    for (const edge of currentArena.edges) {
      const closest = closestPointOnEdge(position, edge);
      const dx = position.x - closest.x;
      const dy = position.y - closest.y;
      const distance = Math.hypot(dx, dy);
      if (distance >= radius) continue;
      const nx = distance ? dx / distance : edge.inwardX;
      const ny = distance ? dy / distance : edge.inwardY;
      position.x = closest.x + nx * radius;
      position.y = closest.y + ny * radius;
      normalX += nx;
      normalY += ny;
    }
    return normalX || normalY ? { x: normalX, y: normalY } : null;
  };

  const POWER_UPS = [
    { key: "speed", label: "Speed", description: "+15% move speed" },
    { key: "push", label: "Push force", description: "+35% knockback" },
    { key: "size", label: "Size", description: "+4 radius" },
  ];

  const statsFor = (powerUps) => ({
    radius: CONFIG.playerRadius + 4 * powerUps.size,
    speed: CONFIG.speed * (1 + 0.15 * powerUps.speed),
    pushMultiplier: 1 + 0.35 * powerUps.push,
  });

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

  const resolveWalls = (position, radius, walls = currentArena.walls) => {
    const boundaryNormal = resolveBoundary(position, radius);
    let normalX = boundaryNormal ? boundaryNormal.x : 0;
    let normalY = boundaryNormal ? boundaryNormal.y : 0;
    for (const wall of walls) {
      const normal = pushOutOfRect(position, radius, wall);
      if (!normal) continue;
      normalX += normal.x;
      normalY += normal.y;
    }
    const length = Math.hypot(normalX, normalY);
    return length ? { x: normalX / length, y: normalY / length } : null;
  };

  const moveCircle = (position, dx, dy, radius, walls = currentArena.walls) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (radius / 2)));
    let hitNormal = null;
    for (let i = 0; i < steps; i++) {
      position.x += dx / steps;
      position.y += dy / steps;
      hitNormal = resolveWalls(position, radius, walls) || hitNormal;
    }
    return hitNormal;
  };

  const moveBy = (player, dx, dy) => moveCircle(player, dx, dy, player.radius);

  const isHardHit = (normal, directionX, directionY) =>
    Boolean(normal) && normal.x * directionX + normal.y * directionY < -CONFIG.hardHitThreshold;

  const canDash = (state) => state.dashTicks === 0 && state.dashCharge >= CONFIG.dashCoinCost;

  const startAiming = (state, dx, dy) => {
    const length = Math.hypot(dx, dy) || 1;
    state.aiming = true;
    state.aimAngle = Math.atan2(state.faceY, state.faceX);
    state.driftX = dx / length;
    state.driftY = dy / length;
  };

  const releaseDash = (state) => {
    state.aiming = false;
    state.dashCharge = 0;
    state.dashTicks = CONFIG.dashTicks;
    state.dashX = Math.cos(state.aimAngle);
    state.dashY = Math.sin(state.aimAngle);
    state.faceX = state.dashX;
    state.faceY = state.dashY;
  };

  const aim = (state, keys) => {
    const turn = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    state.aimAngle += turn * CONFIG.aimTurnSpeed * CONFIG.stepSeconds;
    const distance = state.speed * CONFIG.aimSpeedFactor * CONFIG.stepSeconds;
    moveBy(state, state.driftX * distance, state.driftY * distance);
  };

  const applyInput = (state, keys) => {
    const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    const length = Math.hypot(dx, dy) || 1;
    if (!state.aiming && keys.aim && canDash(state)) startAiming(state, dx, dy);
    if (state.aiming && keys.aim) {
      aim(state, keys);
      return false;
    }
    if (state.aiming) releaseDash(state);
    if (dx || dy) {
      state.faceX = dx / length;
      state.faceY = dy / length;
    }
    if (state.dashTicks > 0) {
      state.dashTicks -= 1;
      const dashStep = (state.radius * 2 * CONFIG.dashDiameters) / CONFIG.dashTicks;
      const wallNormal = moveBy(state, state.dashX * dashStep, state.dashY * dashStep);
      if (!isHardHit(wallNormal, state.dashX, state.dashY)) return false;
      state.dashTicks = 0;
      return true;
    }
    const distance = state.speed * CONFIG.stepSeconds;
    moveBy(state, (dx / length) * distance, (dy / length) * distance);
    return false;
  };

  exports.CONFIG = CONFIG;
  exports.setArena = setArena;
  exports.pointInPolygon = pointInPolygon;
  exports.distanceToBoundary = distanceToBoundary;
  exports.POWER_UPS = POWER_UPS;
  exports.statsFor = statsFor;
  exports.moveCircle = moveCircle;
  exports.applyInput = applyInput;
  exports.moveBy = moveBy;
  exports.resolveWalls = resolveWalls;
  exports.isHardHit = isHardHit;
})(typeof module === "undefined" ? (window.Shared = {}) : module.exports);
