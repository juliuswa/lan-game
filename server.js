const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer, WebSocket } = require("ws");
const { CONFIG, applyInput, moveBy, resolveWalls, isHardHit } = require("./shared");

const PORT = 3000;
const TICK_MS = 1000 / 60;
const MAX_INPUTS_PER_TICK = 8;
const MAX_QUEUED_INPUTS = 120;
const ROUND_RESTART_MS = 4000;
const KNOCKBACK_SPEED = 15;
const KNOCKBACK_FRICTION = 0.9;
const KNOCKBACK_MIN_SPEED = 0.2;
const SPAWNER_SPEED = 1.2;
const SPAWNER_TURN_RATE = 0.2;
const SPAWNER_PUSH_FRICTION = 0.92;
const SPAWNER_DASH_PUSH = 12;
const COIN_SCATTER_DISTANCE = 90;
const WALL_HIT_COIN_LOSS = 1;
const WALL_HIT_INVULNERABLE_MS = 1000;
const COLORS = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe"];
const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/shared.js": { file: "shared.js", type: "text/javascript; charset=utf-8" },
};

const players = new Map();
let coins = [];
let spawner = null;
let winner = null;
let nextId = 1;

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

const bounceOffWalls = () => {
  const normal = resolveWalls(spawner, CONFIG.spawnerRadius);
  if (!normal) return;
  const heading = reflect(Math.cos(spawner.heading), Math.sin(spawner.heading), normal);
  spawner.heading = Math.atan2(heading.y, heading.x);
  const push = reflect(spawner.pushX, spawner.pushY, normal);
  spawner.pushX = push.x;
  spawner.pushY = push.y;
};

const moveSpawner = () => {
  spawner.heading += (Math.random() - 0.5) * SPAWNER_TURN_RATE;
  spawner.x += Math.cos(spawner.heading) * SPAWNER_SPEED + spawner.pushX;
  spawner.y += Math.sin(spawner.heading) * SPAWNER_SPEED + spawner.pushY;
  spawner.pushX *= SPAWNER_PUSH_FRICTION;
  spawner.pushY *= SPAWNER_PUSH_FRICTION;
  bounceOffWalls();
};

const overlapWithSpawner = (player) => {
  const dx = spawner.x - player.x;
  const dy = spawner.y - player.y;
  const distance = Math.hypot(dx, dy);
  const overlap = CONFIG.playerRadius + CONFIG.spawnerRadius - distance;
  return { overlap, normalX: distance ? dx / distance : 1, normalY: distance ? dy / distance : 0 };
};

const pushSpawner = (player) => {
  const { overlap, normalX, normalY } = overlapWithSpawner(player);
  if (overlap <= 0) return;
  spawner.x += normalX * overlap;
  spawner.y += normalY * overlap;
  resolveWalls(spawner, CONFIG.spawnerRadius);
  if (player.dashTicks > 0) {
    player.dashTicks = 0;
    spawner.pushX = normalX * SPAWNER_DASH_PUSH;
    spawner.pushY = normalY * SPAWNER_DASH_PUSH;
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

const resetRound = () => {
  spawner = createSpawner();
  coins = Array.from({ length: CONFIG.coinCount }, spawnCoin);
  for (const player of players.values()) {
    Object.assign(player, randomPosition(CONFIG.playerRadius), freshMotionState(), { score: 0 });
  }
  winner = null;
};

const collectCoins = (player) => {
  coins = coins.map((coin) => {
    if (Math.hypot(coin.x - player.x, coin.y - player.y) > CONFIG.playerRadius + CONFIG.coinRadius) return coin;
    player.score += 1;
    player.dashCharge = Math.min(player.dashCharge + 1, CONFIG.dashCoinCost);
    return spawnCoin();
  });
  if (player.score >= CONFIG.winScore && !winner) {
    winner = player.name;
    setTimeout(resetRound, ROUND_RESTART_MS);
  }
};

const processInputs = (player) => {
  for (const { seq, keys } of player.pendingInputs.splice(0, MAX_INPUTS_PER_TICK)) {
    player.ack = seq;
    if (winner) continue;
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
  victim.knockX = normalX * KNOCKBACK_SPEED;
  victim.knockY = normalY * KNOCKBACK_SPEED;
};

const resolveCollision = (a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  const minDistance = CONFIG.playerRadius * 2;
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
    winner,
    spawner: { x: spawner.x, y: spawner.y },
    coins,
    players: [...players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      x: player.x,
      y: player.y,
      score: player.score,
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
    score: 0,
    ack: 0,
    pendingInputs: [],
    socket,
    ...randomPosition(CONFIG.playerRadius),
    ...freshMotionState(),
  };
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
    }
  });

  socket.on("close", () => {
    if (player) players.delete(player.id);
  });
});

resetRound();
setInterval(tick, TICK_MS);

server.listen(PORT, "0.0.0.0", () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface.family === "IPv4" && !iface.internal && !iface.address.startsWith("169.254"))
    .map((iface) => `http://${iface.address}:${PORT}`);
  console.log("Game running. Friends open:");
  for (const address of addresses) console.log("  " + address);
});
