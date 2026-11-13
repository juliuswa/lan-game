const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer, WebSocket } = require("ws");
const { CONFIG, applyInput, moveBy } = require("./shared");

const PORT = 3000;
const TICK_MS = 1000 / 60;
const MAX_INPUTS_PER_TICK = 8;
const MAX_QUEUED_INPUTS = 120;
const ROUND_RESTART_MS = 4000;
const KNOCKBACK_SPEED = 15;
const KNOCKBACK_FRICTION = 0.9;
const KNOCKBACK_MIN_SPEED = 0.2;
const COLORS = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe"];
const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/shared.js": { file: "shared.js", type: "text/javascript; charset=utf-8" },
};

const players = new Map();
let coins = [];
let winner = null;
let nextId = 1;

const randomPosition = (margin) => ({
  x: margin + Math.random() * (CONFIG.width - 2 * margin),
  y: margin + Math.random() * (CONFIG.height - 2 * margin),
});

const spawnCoin = () => randomPosition(CONFIG.coinRadius * 2);

const freshMotionState = () => ({
  dashTicks: 0,
  dashX: 1,
  dashY: 0,
  faceX: 1,
  faceY: 0,
  dashCharge: CONFIG.dashCoinCost,
  knockX: 0,
  knockY: 0,
});

const resetRound = () => {
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
    applyInput(player, keys);
    collectCoins(player);
  }
};

const applyKnockback = (player) => {
  if (!player.knockX && !player.knockY) return;
  moveBy(player, player.knockX, player.knockY);
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
    coins,
    players: [...players.values()].map(({ id, name, color, x, y, score, ack, dashTicks, dashX, dashY, faceX, faceY, dashCharge }) => ({
      id, name, color, x, y, score, ack, dashTicks, dashX, dashY, faceX, faceY, dashCharge,
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
