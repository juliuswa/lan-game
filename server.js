const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = 3000;
const WIDTH = 800;
const HEIGHT = 600;
const PLAYER_RADIUS = 16;
const COIN_RADIUS = 8;
const SPEED = 220;
const TICK_MS = 1000 / 30;
const COIN_COUNT = 5;
const WIN_SCORE = 20;
const COLORS = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe"];

const players = new Map();
const streams = new Map();
let coins = [];
let winner = null;
let nextId = 1;

const randomPosition = (margin) => ({
  x: margin + Math.random() * (WIDTH - 2 * margin),
  y: margin + Math.random() * (HEIGHT - 2 * margin),
});

const spawnCoin = () => randomPosition(COIN_RADIUS * 2);

const resetRound = () => {
  coins = Array.from({ length: COIN_COUNT }, spawnCoin);
  for (const player of players.values()) {
    Object.assign(player, randomPosition(PLAYER_RADIUS), { score: 0 });
  }
  winner = null;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const tick = () => {
  const dt = TICK_MS / 1000;
  if (!winner) {
    for (const player of players.values()) {
      const { up, down, left, right } = player.input;
      let dx = (right ? 1 : 0) - (left ? 1 : 0);
      let dy = (down ? 1 : 0) - (up ? 1 : 0);
      const length = Math.hypot(dx, dy) || 1;
      player.x = clamp(player.x + (dx / length) * SPEED * dt, PLAYER_RADIUS, WIDTH - PLAYER_RADIUS);
      player.y = clamp(player.y + (dy / length) * SPEED * dt, PLAYER_RADIUS, HEIGHT - PLAYER_RADIUS);

      coins = coins.map((coin) => {
        if (Math.hypot(coin.x - player.x, coin.y - player.y) > PLAYER_RADIUS + COIN_RADIUS) return coin;
        player.score += 1;
        return spawnCoin();
      });

      if (player.score >= WIN_SCORE && !winner) {
        winner = player.name;
        setTimeout(resetRound, 4000);
      }
    }
  }
  broadcast();
};

const broadcast = () => {
  const state = JSON.stringify({
    width: WIDTH,
    height: HEIGHT,
    playerRadius: PLAYER_RADIUS,
    coinRadius: COIN_RADIUS,
    speed: SPEED,
    winScore: WIN_SCORE,
    winner,
    coins,
    players: [...players.values()].map(({ id, name, color, x, y, score }) => ({ id, name, color, x, y, score })),
  });
  for (const res of streams.values()) res.write(`data: ${state}\n\n`);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });

const sendJson = (res, body) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/join") {
    const { name } = await readBody(req);
    const id = String(nextId++);
    players.set(id, {
      id,
      name: String(name || `Player ${id}`).slice(0, 16),
      color: COLORS[(Number(id) - 1) % COLORS.length],
      score: 0,
      input: {},
      ...randomPosition(PLAYER_RADIUS),
    });
    sendJson(res, { id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/input") {
    const { id, input } = await readBody(req);
    const player = players.get(id);
    if (player && input) player.input = input;
    sendJson(res, { ok: Boolean(player) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const id = url.searchParams.get("id");
    if (!players.has(id)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.socket.setNoDelay(true);
    streams.set(id, res);
    req.on("close", () => {
      streams.delete(id);
      players.delete(id);
    });
    return;
  }

  res.writeHead(404);
  res.end();
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
