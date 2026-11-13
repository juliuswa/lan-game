const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer, WebSocket } = require("ws");
const { CONFIG, POWER_UPS, statsFor, applyInput, moveBy, moveCircle, resolveWalls, isHardHit, setWalls } = require("./shared");

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
const COIN_SCATTER_DISTANCE = 90;
const ARENA_BORDER_ONLY = [];
const WALL_HIT_COIN_LOSS = 3;
const WALL_COUNT = 7;
const WALL_THICKNESS = 24;
const WALL_MIN_LENGTH = 70;
const WALL_MAX_LENGTH = 170;
const WALL_EDGE_MARGIN = 60;
const WALL_MIN_GAP = 90;
const WALL_PLACEMENT_ATTEMPTS = 200;
const WALL_HIT_INVULNERABLE_MS = 1000;
const COLORS = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe"];
const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/shared.js": { file: "shared.js", type: "text/javascript; charset=utf-8" },
};

const players = new Map();
let coins = [];
let walls = [];
let spawner = null;
let phase = "playing";
let roundWinner = null;
let matchWinner = null;
let phaseMinEndsAt = 0;
let phaseEndsAt = 0;
let nextId = 1;

const randomBetween = (min, max) => min + Math.random() * (max - min);

const randomWall = () => {
  const length = randomBetween(WALL_MIN_LENGTH, WALL_MAX_LENGTH);
  const horizontal = Math.random() < 0.5;
  const w = horizontal ? length : WALL_THICKNESS;
  const h = horizontal ? WALL_THICKNESS : length;
  return {
    x: Math.round(randomBetween(WALL_EDGE_MARGIN, CONFIG.width - WALL_EDGE_MARGIN - w)),
    y: Math.round(randomBetween(WALL_EDGE_MARGIN, CONFIG.height - WALL_EDGE_MARGIN - h)),
    w: Math.round(w),
    h: Math.round(h),
  };
};

const wallsTooClose = (a, b) =>
  a.x < b.x + b.w + WALL_MIN_GAP && b.x < a.x + a.w + WALL_MIN_GAP && a.y < b.y + b.h + WALL_MIN_GAP && b.y < a.y + a.h + WALL_MIN_GAP;

const generateWalls = () => {
  const placed = [];
  for (let attempt = 0; attempt < WALL_PLACEMENT_ATTEMPTS && placed.length < WALL_COUNT; attempt++) {
    const candidate = randomWall();
    if (!placed.some((wall) => wallsTooClose(wall, candidate))) placed.push(candidate);
  }
  return placed;
};

const randomPosition = (radius) => {
  const position = {
    x: radius + Math.random() * (CONFIG.width - 2 * radius),
    y: radius + Math.random() * (CONFIG.height - 2 * radius),
  };
  resolveWalls(position, radius);
  return position;
};

const spawnCoin = () => {
  const angle = Math.random() * Math.PI * 2;
  const minDistance = CONFIG.spawnerRadius + CONFIG.coinRadius + 4;
  const distance = minDistance + Math.random() * (COIN_SCATTER_DISTANCE - minDistance);
  const coin = { x: spawner.x + Math.cos(angle) * distance, y: spawner.y + Math.sin(angle) * distance };
  resolveWalls(coin, CONFIG.coinRadius * 2);
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

const moveSpawner = () => {
  spawner.heading += (Math.random() - 0.5) * SPAWNER_TURN_RATE;
  const normal = moveCircle(
    spawner,
    Math.cos(spawner.heading) * SPAWNER_SPEED + spawner.pushX,
    Math.sin(spawner.heading) * SPAWNER_SPEED + spawner.pushY,
    CONFIG.spawnerRadius,
    ARENA_BORDER_ONLY,
  );
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
  }
  const remaining = overlapWithSpawner(player);
  if (remaining.overlap > 0) moveBy(player, -remaining.normalX * remaining.overlap, -remaining.normalY * remaining.overlap);
};

const freshMotionState = () => ({
  dashTicks: 0,
  dashX: 1,
  dashY: 0,
  faceX: 1,
  faceY: 0,
  dashCharge: CONFIG.dashCoinCost,
  knockX: 0,
  knockY: 0,
  invulnerableUntil: 0,
});

const hitWall = (player) => {
  const now = Date.now();
  if (now < player.invulnerableUntil) return;
  player.score = Math.max(0, player.score - WALL_HIT_COIN_LOSS);
  player.invulnerableUntil = now + WALL_HIT_INVULNERABLE_MS;
};

const emptyPowerUps = () => Object.fromEntries(POWER_UPS.map(({ key }) => [key, 0]));

const placeForNewRound = (player) => {
  Object.assign(player, statsFor(player.powerUps), freshMotionState(), { score: 0, pendingPick: false });
  Object.assign(player, randomPosition(player.radius));
};

const startRound = () => {
  walls = generateWalls();
  setWalls(walls);
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

const collectCoins = (player) => {
  coins = coins.map((coin) => {
    if (Math.hypot(coin.x - player.x, coin.y - player.y) > player.radius + CONFIG.coinRadius) return coin;
    player.score += 1;
    player.dashCharge = Math.min(player.dashCharge + 1, CONFIG.dashCoinCost);
    return spawnCoin();
  });
  if (player.score >= CONFIG.winScore && phase === "playing") endRound(player);
};

const processInputs = (player) => {
  for (const { seq, keys } of player.pendingInputs.splice(0, MAX_INPUTS_PER_TICK)) {
    player.ack = seq;
    if (phase !== "playing") continue;
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
    roundWinner,
    matchWinner,
    pickSecondsLeft: phase === "intermission" ? Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000)) : 0,
    walls,
    spawner: { x: spawner.x, y: spawner.y },
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
      dashX: player.dashX,
      dashY: player.dashY,
      faceX: player.faceX,
      faceY: player.faceY,
      dashCharge: player.dashCharge,
      hurt: Date.now() < player.invulnerableUntil,
    })),
  });
  for (const player of players.values()) {
    if (player.socket.readyState === WebSocket.OPEN) player.socket.send(message);
  }
};

const tick = () => {
  updatePhase();
  for (const player of players.values()) processInputs(player);
  for (const player of players.values()) applyKnockback(player);
  resolveCollisions();
  moveSpawner();
  for (const player of players.values()) pushSpawner(player);
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
  dash: Boolean(keys.dash),
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
