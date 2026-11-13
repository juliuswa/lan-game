const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer, WebSocket } = require("ws");
const { CONFIG, POWER_UPS, statsFor, applyInput, moveBy, moveCircle, resolveWalls, isHardHit, setArena, pointInPolygon, distanceToBoundary } = require("./shared");

const PORT = 3000;
const TICK_MS = 1000 / 60;
const MAX_INPUTS_PER_TICK = 8;
const MAX_QUEUED_INPUTS = 120;
const INTERMISSION_MIN_MS = 2500;
const PICK_TIMEOUT_MS = 20000;
const MATCH_OVER_MS = 6000;
const KNOCKBACK_SPEED = 15;
const KNOCKBACK_FRICTION = 0.9;
const KNOCKBACK_MIN_SPEED = 0.2;
const SPAWNER_SPEED = 1.2;
const SPAWNER_TURN_RATE = 0.2;
const SPAWNER_PUSH_FRICTION = 0.92;
const SPAWNER_DASH_PUSH = 12;
const SPAWNER_BREAK_SPEED = 6;
const SPAWNER_RESPAWN_MS = 3000;
const BLACK_HOLE_RADIUS = 22;
const MAX_BLACK_HOLES = 2;
const BLACK_HOLE_LIFETIME_MS = 8000;
const BLACK_HOLE_SPAWN_MIN_MS = 3000;
const BLACK_HOLE_SPAWN_MAX_MS = 7000;
const BONUS_COINS = 5;
const TRAP_RADIUS = 10;
const MAX_TRAPS = 6;
const TRAP_DROP_MIN_MS = 5000;
const TRAP_DROP_MAX_MS = 15000;
const TRAP_HOLD_MS = 5000;
const COIN_SCATTER_DISTANCE = 90;
const ARENA_BORDER_ONLY = [];
const WALL_HIT_COIN_LOSS = 3;
const WALL_COUNT = 7;
const WALL_THICKNESS = 24;
const WALL_MIN_LENGTH = 70;
const WALL_MAX_LENGTH = 170;
const WALL_BOUNDARY_GAP = 70;
const WALL_MIN_GAP = 90;
const WALL_PLACEMENT_ATTEMPTS = 300;
const WALL_SAMPLE_SPACING = 20;
const POSITION_ATTEMPTS = 500;
const ELLIPSE_SEGMENTS = 32;
const WALL_HIT_INVULNERABLE_MS = 1000;
const COLORS = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe"];
const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/shared.js": { file: "shared.js", type: "text/javascript; charset=utf-8" },
  "/effects.js": { file: "effects.js", type: "text/javascript; charset=utf-8" },
};

const players = new Map();
let coins = [];
let arena = null;
let spawner = null;
let spawnerRespawnAt = 0;
let blackHoles = [];
let nextBlackHoleAt = 0;
let traps = [];
let events = [];
let nextTrapAt = 0;
let phase = "playing";
let roundWinner = null;
let matchWinner = null;
let phaseMinEndsAt = 0;
let phaseEndsAt = 0;
let nextId = 1;

const randomBetween = (min, max) => min + Math.random() * (max - min);

const emit = (type, data) => events.push({ type, ...data });

const W = CONFIG.width;
const H = CONFIG.height;

const regularPolygon = (sides, rotation) =>
  Array.from({ length: sides }, (_, i) => {
    const angle = rotation + (i / sides) * Math.PI * 2;
    return [W / 2 + (Math.cos(angle) * W) / 2, H / 2 + (Math.sin(angle) * H) / 2];
  });

const ARENA_SHAPES = [
  () => [[0, 0], [W, 0], [W, H], [0, H]],
  () => regularPolygon(ELLIPSE_SEGMENTS, 0),
  () => regularPolygon(6, 0),
  () => regularPolygon(8, Math.PI / 8),
  () => [[260, 0], [540, 0], [540, 170], [W, 170], [W, 430], [540, 430], [540, H], [260, H], [260, 430], [0, 430], [0, 170], [260, 170]],
  () => [[0, 0], [380, 0], [380, 300], [W, 300], [W, H], [0, H]],
  () => [[0, 0], [260, 0], [260, 330], [540, 330], [540, 0], [W, 0], [W, H], [0, H]],
  () => [[W / 2, 0], [W, H / 2], [W / 2, H], [0, H / 2]],
];

const randomBoundary = () => {
  const boundary = ARENA_SHAPES[Math.floor(Math.random() * ARENA_SHAPES.length)]();
  const flipX = Math.random() < 0.5;
  const flipY = Math.random() < 0.5;
  return boundary.map(([x, y]) => [Math.round(flipX ? W - x : x), Math.round(flipY ? H - y : y)]);
};

const randomWall = () => {
  const length = randomBetween(WALL_MIN_LENGTH, WALL_MAX_LENGTH);
  const horizontal = Math.random() < 0.5;
  const w = horizontal ? length : WALL_THICKNESS;
  const h = horizontal ? WALL_THICKNESS : length;
  return {
    x: Math.round(randomBetween(0, W - w)),
    y: Math.round(randomBetween(0, H - h)),
    w: Math.round(w),
    h: Math.round(h),
  };
};

const wallPerimeterPoints = (wall) => {
  const points = [];
  for (let x = wall.x; x <= wall.x + wall.w; x += WALL_SAMPLE_SPACING) points.push({ x, y: wall.y }, { x, y: wall.y + wall.h });
  for (let y = wall.y; y <= wall.y + wall.h; y += WALL_SAMPLE_SPACING) points.push({ x: wall.x, y }, { x: wall.x + wall.w, y });
  points.push({ x: wall.x + wall.w, y: wall.y + wall.h });
  return points;
};

const fitsInArena = (wall) =>
  wallPerimeterPoints(wall).every((point) => pointInPolygon(point) && distanceToBoundary(point) >= WALL_BOUNDARY_GAP);

const wallsTooClose = (a, b) =>
  a.x < b.x + b.w + WALL_MIN_GAP && b.x < a.x + a.w + WALL_MIN_GAP && a.y < b.y + b.h + WALL_MIN_GAP && b.y < a.y + a.h + WALL_MIN_GAP;

const generateWalls = () => {
  const placed = [];
  for (let attempt = 0; attempt < WALL_PLACEMENT_ATTEMPTS && placed.length < WALL_COUNT; attempt++) {
    const candidate = randomWall();
    if (fitsInArena(candidate) && !placed.some((wall) => wallsTooClose(wall, candidate))) placed.push(candidate);
  }
  return placed;
};

const isOpenSpot = (position, radius) =>
  pointInPolygon(position) &&
  distanceToBoundary(position) >= radius &&
  arena.walls.every((wall) => Math.hypot(Math.max(wall.x - position.x, 0, position.x - wall.x - wall.w), Math.max(wall.y - position.y, 0, position.y - wall.y - wall.h)) >= radius) &&
  blackHoles.every((hole) => Math.hypot(hole.x - position.x, hole.y - position.y) >= radius + BLACK_HOLE_RADIUS);

const randomPosition = (radius) => {
  let position = null;
  for (let attempt = 0; attempt < POSITION_ATTEMPTS; attempt++) {
    position = { x: randomBetween(radius, W - radius), y: randomBetween(radius, H - radius) };
    if (isOpenSpot(position, radius)) return position;
  }
  resolveWalls(position, radius);
  return position;
};

const generateArena = () => {
  const boundary = randomBoundary();
  setArena({ boundary, walls: [] });
  const walls = generateWalls();
  setArena({ boundary, walls });
  return { boundary, walls };
};

const spawnCoin = () => {
  const angle = Math.random() * Math.PI * 2;
  const minDistance = CONFIG.spawnerRadius + CONFIG.coinRadius + 4;
  const distance = minDistance + Math.random() * (COIN_SCATTER_DISTANCE - minDistance);
  const coin = { x: spawner.x + Math.cos(angle) * distance, y: spawner.y + Math.sin(angle) * distance };
  resolveWalls(coin, CONFIG.coinRadius * 2);
  emit("coinSpawn", { x: coin.x, y: coin.y });
  return coin;
};

const createSpawner = () => ({
  ...randomPosition(CONFIG.spawnerRadius),
  heading: Math.random() * Math.PI * 2,
  pushX: 0,
  pushY: 0,
});

const reflect = (x, y, normal) => {
  const dot = x * normal.x + y * normal.y;
  if (dot >= 0) return { x, y };
  return { x: x - 2 * dot * normal.x, y: y - 2 * dot * normal.y };
};

const bounceOffWalls = (normal) => {
  if (!normal) return;
  const heading = reflect(Math.cos(spawner.heading), Math.sin(spawner.heading), normal);
  spawner.heading = Math.atan2(heading.y, heading.x);
  const push = reflect(spawner.pushX, spawner.pushY, normal);
  spawner.pushX = push.x;
  spawner.pushY = push.y;
};

const breakSpawner = () => {
  emit("spawnerBreak", { x: spawner.x, y: spawner.y });
  spawner = null;
  spawnerRespawnAt = Date.now() + SPAWNER_RESPAWN_MS;
};

const respawnSpawnerWhenDue = () => {
  if (spawner || Date.now() < spawnerRespawnAt) return;
  spawner = createSpawner();
  emit("spawnerSpawn", { x: spawner.x, y: spawner.y });
  while (coins.length < CONFIG.coinCount) coins.push(spawnCoin());
};

const slammedIntoBorder = (normal) => {
  const pushSpeed = Math.hypot(spawner.pushX, spawner.pushY);
  return pushSpeed > SPAWNER_BREAK_SPEED && isHardHit(normal, spawner.pushX / pushSpeed, spawner.pushY / pushSpeed);
};

const moveSpawner = () => {
  if (!spawner) return;
  spawner.heading += (Math.random() - 0.5) * SPAWNER_TURN_RATE;
  const normal = moveCircle(
    spawner,
    Math.cos(spawner.heading) * SPAWNER_SPEED + spawner.pushX,
    Math.sin(spawner.heading) * SPAWNER_SPEED + spawner.pushY,
    CONFIG.spawnerRadius,
    ARENA_BORDER_ONLY,
  );
  if (slammedIntoBorder(normal)) {
    breakSpawner();
    return;
  }
  spawner.pushX *= SPAWNER_PUSH_FRICTION;
  spawner.pushY *= SPAWNER_PUSH_FRICTION;
  bounceOffWalls(normal);
};

const overlapWithSpawner = (player) => {
  const dx = spawner.x - player.x;
  const dy = spawner.y - player.y;
  const distance = Math.hypot(dx, dy);
  const overlap = player.radius + CONFIG.spawnerRadius - distance;
  return { overlap, normalX: distance ? dx / distance : 1, normalY: distance ? dy / distance : 0 };
};

const pushSpawner = (player) => {
  const { overlap, normalX, normalY } = overlapWithSpawner(player);
  if (overlap <= 0) return;
  spawner.x += normalX * overlap;
  spawner.y += normalY * overlap;
  resolveWalls(spawner, CONFIG.spawnerRadius, ARENA_BORDER_ONLY);
  if (player.dashTicks > 0) {
    player.dashTicks = 0;
    spawner.pushX = normalX * SPAWNER_DASH_PUSH * player.pushMultiplier;
    spawner.pushY = normalY * SPAWNER_DASH_PUSH * player.pushMultiplier;
    emit("spawnerHit", {
      x: player.x + normalX * player.radius,
      y: player.y + normalY * player.radius,
      normalX,
      normalY,
      strength: player.pushMultiplier,
      attackerId: player.id,
    });
  }
  const remaining = overlapWithSpawner(player);
  if (remaining.overlap > 0) moveBy(player, -remaining.normalX * remaining.overlap, -remaining.normalY * remaining.overlap);
};

const freshMotionState = () => ({
  dashTicks: 0,
  aiming: false,
  aimAngle: 0,
  driftX: 0,
  driftY: 0,
  dashX: 1,
  dashY: 0,
  faceX: 1,
  faceY: 0,
  dashCharge: CONFIG.dashCoinCost,
  knockX: 0,
  knockY: 0,
  invulnerableUntil: 0,
  trappedUntil: 0,
});

const hitWall = (player) => {
  const now = Date.now();
  if (now < player.invulnerableUntil) return;
  const lost = Math.min(player.score, WALL_HIT_COIN_LOSS);
  player.score -= lost;
  player.invulnerableUntil = now + WALL_HIT_INVULNERABLE_MS;
  emit("wallHit", { x: player.x, y: player.y, playerId: player.id, lost });
};

const emptyPowerUps = () => Object.fromEntries(POWER_UPS.map(({ key }) => [key, 0]));

const placeForNewRound = (player) => {
  Object.assign(player, statsFor(player.powerUps), freshMotionState(), { score: 0, pendingPick: false });
  Object.assign(player, randomPosition(player.radius));
  emit("playerSpawn", { x: player.x, y: player.y, radius: player.radius, color: player.color });
};

const scheduleNextBlackHole = () => {
  nextBlackHoleAt = Date.now() + randomBetween(BLACK_HOLE_SPAWN_MIN_MS, BLACK_HOLE_SPAWN_MAX_MS);
};

const updateBlackHoles = () => {
  const now = Date.now();
  for (const hole of blackHoles) if (hole.expiresAt <= now) emit("holeClose", { x: hole.x, y: hole.y });
  blackHoles = blackHoles.filter((hole) => hole.expiresAt > now);
  if (now < nextBlackHoleAt) return;
  if (blackHoles.length < MAX_BLACK_HOLES) {
    const hole = { ...randomPosition(BLACK_HOLE_RADIUS), expiresAt: now + BLACK_HOLE_LIFETIME_MS };
    blackHoles.push(hole);
    emit("holeOpen", { x: hole.x, y: hole.y });
  }
  scheduleNextBlackHole();
};

const scheduleNextTrap = () => {
  nextTrapAt = Date.now() + randomBetween(TRAP_DROP_MIN_MS, TRAP_DROP_MAX_MS);
};

const dropTrapWhenDue = () => {
  if (Date.now() < nextTrapAt || !spawner) return;
  if (traps.length >= MAX_TRAPS) {
    scheduleNextTrap();
    return;
  }
  const position = { x: spawner.x, y: spawner.y };
  if (!isOpenSpot(position, TRAP_RADIUS)) return;
  traps.push(position);
  emit("trapDrop", position);
  scheduleNextTrap();
};

const isTrapped = (player) => Date.now() < player.trappedUntil;

const stepOnTraps = (player) => {
  if (isTrapped(player)) return;
  const trap = traps.find((candidate) => Math.hypot(candidate.x - player.x, candidate.y - player.y) < player.radius + TRAP_RADIUS);
  if (!trap) return;
  traps = traps.filter((candidate) => candidate !== trap);
  Object.assign(player, { trappedUntil: Date.now() + TRAP_HOLD_MS, dashTicks: 0, aiming: false });
  emit("trapSnap", { x: player.x, y: player.y, radius: player.radius, playerId: player.id });
};

const fallIntoBlackHoles = (player) => {
  if (!blackHoles.some((hole) => Math.hypot(hole.x - player.x, hole.y - player.y) < BLACK_HOLE_RADIUS)) return;
  const from = { x: player.x, y: player.y };
  Object.assign(player, randomPosition(player.radius), { dashTicks: 0, aiming: false, knockX: 0, knockY: 0 });
  emit("teleport", { fromX: from.x, fromY: from.y, toX: player.x, toY: player.y, radius: player.radius, color: player.color, playerId: player.id });
};

const startRound = () => {
  blackHoles = [];
  traps = [];
  scheduleNextTrap();
  scheduleNextBlackHole();
  arena = generateArena();
  spawner = createSpawner();
  coins = Array.from({ length: CONFIG.coinCount }, spawnCoin);
  for (const player of players.values()) placeForNewRound(player);
  phase = "playing";
  roundWinner = null;
};

const startMatch = () => {
  for (const player of players.values()) {
    player.roundWins = 0;
    player.powerUps = emptyPowerUps();
  }
  matchWinner = null;
  startRound();
};

const endRound = (winnerPlayer) => {
  const now = Date.now();
  roundWinner = winnerPlayer.name;
  winnerPlayer.roundWins += 1;
  if (winnerPlayer.roundWins >= CONFIG.roundsToWin) {
    matchWinner = winnerPlayer.name;
    phase = "matchOver";
    phaseEndsAt = now + MATCH_OVER_MS;
    return;
  }
  const lowestScore = Math.min(...[...players.values()].map((player) => player.score));
  for (const player of players.values()) player.pendingPick = player.score === lowestScore;
  phase = "intermission";
  phaseMinEndsAt = now + INTERMISSION_MIN_MS;
  phaseEndsAt = now + PICK_TIMEOUT_MS;
};

const grantPowerUp = (player, key) => {
  player.powerUps[key] += 1;
  player.pendingPick = false;
};

const randomPowerUpKey = () => POWER_UPS[Math.floor(Math.random() * POWER_UPS.length)].key;

const updatePhase = () => {
  const now = Date.now();
  if (phase === "intermission") {
    const waiting = [...players.values()].filter((player) => player.pendingPick);
    if (now >= phaseEndsAt) {
      for (const player of waiting) grantPowerUp(player, randomPowerUpKey());
      startRound();
    } else if (waiting.length === 0 && now >= phaseMinEndsAt) {
      startRound();
    }
  } else if (phase === "matchOver" && now >= phaseEndsAt) {
    startMatch();
  }
};

const awardBonusCoins = (player) => {
  emit("bonus", { x: player.x, y: player.y, amount: BONUS_COINS, playerId: player.id });
  awardCoins(player, BONUS_COINS);
};

const awardCoins = (player, count) => {
  player.score += count;
  player.dashCharge = Math.min(player.dashCharge + count, CONFIG.dashCoinCost);
  if (player.score >= CONFIG.winScore && phase === "playing") endRound(player);
};

const collectCoins = (player) => {
  let collected = 0;
  coins = coins.flatMap((coin) => {
    if (Math.hypot(coin.x - player.x, coin.y - player.y) > player.radius + CONFIG.coinRadius) return [coin];
    collected += 1;
    emit("coin", { x: coin.x, y: coin.y, playerX: player.x, playerY: player.y, playerId: player.id });
    return spawner ? [spawnCoin()] : [];
  });
  if (collected) awardCoins(player, collected);
};

const processInputs = (player) => {
  for (const { seq, keys } of player.pendingInputs.splice(0, MAX_INPUTS_PER_TICK)) {
    player.ack = seq;
    if (phase !== "playing" || isTrapped(player)) continue;
    if (applyInput(player, keys)) hitWall(player);
    collectCoins(player);
  }
};

const applyKnockback = (player) => {
  if (!player.knockX && !player.knockY) return;
  const wallNormal = moveBy(player, player.knockX, player.knockY);
  if (isHardHit(wallNormal, player.knockX, player.knockY)) {
    hitWall(player);
    player.knockX = 0;
    player.knockY = 0;
    return;
  }
  player.knockX *= KNOCKBACK_FRICTION;
  player.knockY *= KNOCKBACK_FRICTION;
  if (Math.hypot(player.knockX, player.knockY) < KNOCKBACK_MIN_SPEED) {
    player.knockX = 0;
    player.knockY = 0;
  }
};

const knockBack = (attacker, victim, normalX, normalY) => {
  attacker.dashTicks = 0;
  emit("hit", {
    x: attacker.x + normalX * attacker.radius,
    y: attacker.y + normalY * attacker.radius,
    normalX,
    normalY,
    strength: attacker.pushMultiplier,
    color: attacker.color,
    attackerId: attacker.id,
    victimId: victim.id,
  });
  victim.knockX = normalX * KNOCKBACK_SPEED * attacker.pushMultiplier;
  victim.knockY = normalY * KNOCKBACK_SPEED * attacker.pushMultiplier;
};

const resolveCollision = (a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  const minDistance = a.radius + b.radius;
  if (distance >= minDistance) return;
  const normalX = distance ? dx / distance : 1;
  const normalY = distance ? dy / distance : 0;
  const halfOverlap = (minDistance - distance) / 2;
  moveBy(a, -normalX * halfOverlap, -normalY * halfOverlap);
  moveBy(b, normalX * halfOverlap, normalY * halfOverlap);
  const aDashing = a.dashTicks > 0;
  const bDashing = b.dashTicks > 0;
  if (aDashing) knockBack(a, b, normalX, normalY);
  if (bDashing) knockBack(b, a, -normalX, -normalY);
};

const resolveCollisions = () => {
  const list = [...players.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) resolveCollision(list[i], list[j]);
  }
};

const broadcast = () => {
  const message = JSON.stringify({
    type: "state",
    phase,
    events,
    roundWinner,
    matchWinner,
    pickSecondsLeft: phase === "intermission" ? Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000)) : 0,
    arena,
    traps: traps.map(({ x, y }) => ({ x, y, radius: TRAP_RADIUS })),
    blackHoles: blackHoles.map((hole) => ({
      x: hole.x,
      y: hole.y,
      radius: BLACK_HOLE_RADIUS,
      lifeLeft: Math.max(0, (hole.expiresAt - Date.now()) / BLACK_HOLE_LIFETIME_MS),
    })),
    spawner: spawner && { x: spawner.x, y: spawner.y },
    coins,
    players: [...players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      x: player.x,
      y: player.y,
      score: player.score,
      roundWins: player.roundWins,
      powerUps: player.powerUps,
      pendingPick: player.pendingPick,
      radius: player.radius,
      speed: player.speed,
      ack: player.ack,
      dashTicks: player.dashTicks,
      aiming: player.aiming,
      aimAngle: player.aimAngle,
      driftX: player.driftX,
      driftY: player.driftY,
      dashX: player.dashX,
      dashY: player.dashY,
      faceX: player.faceX,
      faceY: player.faceY,
      dashCharge: player.dashCharge,
      hurt: Date.now() < player.invulnerableUntil,
      trapped: isTrapped(player),
      trapSecondsLeft: Math.max(0, Math.ceil((player.trappedUntil - Date.now()) / 1000)),
    })),
  });
  for (const player of players.values()) {
    if (player.socket.readyState === WebSocket.OPEN) player.socket.send(message);
  }
  events = [];
};

const tick = () => {
  updatePhase();
  for (const player of players.values()) processInputs(player);
  for (const player of players.values()) applyKnockback(player);
  resolveCollisions();
  respawnSpawnerWhenDue();
  moveSpawner();
  if (spawner) for (const player of players.values()) pushSpawner(player);
  if (phase === "playing") {
    updateBlackHoles();
    dropTrapWhenDue();
    for (const player of players.values()) {
      fallIntoBlackHoles(player);
      stepOnTraps(player);
    }
  }
  broadcast();
};

const createPlayer = (name, socket) => {
  const id = String(nextId++);
  const player = {
    id,
    name: String(name || `Player ${id}`).slice(0, 16),
    color: COLORS[(Number(id) - 1) % COLORS.length],
    ack: 0,
    roundWins: 0,
    powerUps: emptyPowerUps(),
    pendingInputs: [],
    socket,
  };
  placeForNewRound(player);
  players.set(id, player);
  return player;
};

const sanitizeKeys = (keys = {}) => ({
  up: Boolean(keys.up),
  down: Boolean(keys.down),
  left: Boolean(keys.left),
  right: Boolean(keys.right),
  aim: Boolean(keys.aim),
  aimAngle: Number.isFinite(keys.aimAngle) ? keys.aimAngle : undefined,
});

const server = http.createServer((req, res) => {
  const staticFile = STATIC_FILES[new URL(req.url, "http://localhost").pathname];
  if (!staticFile) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": staticFile.type, "Cache-Control": "no-cache" });
  fs.createReadStream(path.join(__dirname, staticFile.file)).pipe(res);
});

new WebSocketServer({ server }).on("connection", (socket) => {
  let player = null;

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.type === "join" && !player) {
      player = createPlayer(message.name, socket);
      socket.send(JSON.stringify({ type: "welcome", id: player.id }));
    } else if (message.type === "input" && player && Number.isInteger(message.seq) && message.seq > player.ack) {
      if (player.pendingInputs.length < MAX_QUEUED_INPUTS) {
        player.pendingInputs.push({ seq: message.seq, keys: sanitizeKeys(message.keys) });
      }
    } else if (message.type === "bonusCoins" && player && phase === "playing") {
      awardBonusCoins(player);
    } else if (message.type === "pick" && player && phase === "intermission" && player.pendingPick) {
      if (POWER_UPS.some(({ key }) => key === message.powerUp)) grantPowerUp(player, message.powerUp);
    }
  });

  socket.on("close", () => {
    if (player) players.delete(player.id);
  });
});

startMatch();
setInterval(tick, TICK_MS);

server.listen(PORT, "0.0.0.0", () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface.family === "IPv4" && !iface.internal && !iface.address.startsWith("169.254"))
    .map((iface) => `http://${iface.address}:${PORT}`);
  console.log("Game running. Friends open:");
  for (const address of addresses) console.log("  " + address);
});
