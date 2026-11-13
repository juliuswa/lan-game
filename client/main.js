import { createWorld } from "./world.js";
import { createEffects } from "./effects.js";
import { createHud } from "./hud.js";
import { createAudio, musicLevelFor } from "./audio.js";

const { CONFIG, POWER_UPS, applyInput, setArena } = window.Shared;
const INTERPOLATION_DELAY_MS = 50;
const SNAPSHOT_HISTORY_MS = 1000;
const STEP_MS = CONFIG.stepSeconds * 1000;
const MOVING_THRESHOLD = 0.3;
const KEY_DIRECTIONS = { ArrowUp: "up", w: "up", ArrowDown: "down", s: "down", ArrowLeft: "left", a: "left", ArrowRight: "right", d: "right" };
const LOCK_KEYS = ["w", "a", "s", "d"];

const stage = document.getElementById("stage");
const world = createWorld(stage);
const effects = createEffects(world.scene);
const audio = createAudio();
const muteButton = document.getElementById("mute");
const hud = createHud({ scoreList: document.getElementById("scores"), overlay: document.getElementById("overlay") });

const keys = { up: false, down: false, left: false, right: false };
let dashRequested = false;
let pointer = null;
let socket = null;
let playerId = null;
let latestState = null;
let predicted = null;
let pendingInputs = [];
let nextSeq = 1;
let selectedPowerUp = 0;
let snapshots = [];
let accumulator = 0;
let lastFrameTime = performance.now();
let trailToggle = false;
const lastPositions = new Map();
const lastDashTicks = new Map();
let lastLockProgress = 0;

const directionOf = (event) => KEY_DIRECTIONS[event.key.length === 1 ? event.key.toLowerCase() : event.key];
const isMoving = () => keys.up || keys.down || keys.left || keys.right;
const myPlayer = () => latestState && latestState.players.find((player) => player.id === playerId);
const isPicking = () => latestState && latestState.phase === "intermission" && Boolean(myPlayer() && myPlayer().pendingPick);
const send = (message) => socket.send(JSON.stringify(message));

const handlePickKey = (event) => {
  const direction = directionOf(event);
  if (direction === "left" || direction === "up") selectedPowerUp = (selectedPowerUp + POWER_UPS.length - 1) % POWER_UPS.length;
  else if (direction === "right" || direction === "down") selectedPowerUp = (selectedPowerUp + 1) % POWER_UPS.length;
  else if (event.code === "Space" && !event.repeat) {
    send({ type: "pick", powerUp: POWER_UPS[selectedPowerUp].key });
    audio.uiConfirm();
    event.preventDefault();
    return;
  } else return;
  audio.uiMove();
  event.preventDefault();
};

const updateMuteButton = () => {
  muteButton.textContent = audio.isMuted() ? "🔇" : "🔊";
};

const toggleMute = () => {
  audio.unlock();
  audio.toggleMute();
  updateMuteButton();
};

const setKey = (event, pressed) => {
  if (!playerId) return;
  if (pressed && event.key.toLowerCase() === "m" && !event.repeat) {
    toggleMute();
    return;
  }
  if (pressed && isPicking()) {
    handlePickKey(event);
    return;
  }
  if (pressed && predicted && predicted.trapped && LOCK_KEYS.includes(event.key.toLowerCase())) {
    event.preventDefault();
    if (!event.repeat) send({ type: "unlockKey", key: event.key.toLowerCase() });
    return;
  }
  if (event.code === "Space") {
    event.preventDefault();
    if (!pressed || event.repeat) return;
    if (latestState && latestState.phase === "ready") {
      send({ type: "ready" });
      audio.uiConfirm();
    }
    else dashRequested = true;
    return;
  }
  const direction = directionOf(event);
  if (!direction) return;
  event.preventDefault();
  keys[direction] = pressed;
};

muteButton.addEventListener("click", toggleMute);
updateMuteButton();

addEventListener("keydown", (event) => setKey(event, true));
addEventListener("keyup", (event) => setKey(event, false));
addEventListener("blur", () => Object.keys(keys).forEach((key) => (keys[key] = false)));
stage.addEventListener("pointermove", (event) => {
  pointer = { clientX: event.clientX, clientY: event.clientY };
});

const mouseAimAngle = () => {
  if (!pointer || !predicted) return undefined;
  const target = world.toGame(pointer.clientX, pointer.clientY);
  return target ? Math.atan2(target.y - predicted.y, target.x - predicted.x) : undefined;
};

const reconcile = (state) => {
  const me = state.players.find((player) => player.id === playerId);
  if (!me) return;
  pendingInputs = pendingInputs.filter((input) => input.seq > me.ack);
  const { x, y, dashTicks, dashX, dashY, faceX, faceY, dashCharge, radius, speed, trapped } = me;
  predicted = { x, y, dashTicks, dashX, dashY, faceX, faceY, dashCharge, radius, speed, trapped };
  if (state.phase === "playing" && !trapped) for (const input of pendingInputs) applyInput(predicted, input.keys);
};

const simulateStep = () => {
  if (!predicted || latestState.phase !== "playing" || predicted.trapped) {
    dashRequested = false;
    return;
  }
  if (!isMoving() && !dashRequested && predicted.dashTicks === 0) return;
  const input = { seq: nextSeq++, keys: { ...keys, dash: dashRequested, aimAngle: mouseAimAngle() } };
  dashRequested = false;
  pendingInputs.push(input);
  const wasDashing = predicted.dashTicks > 0;
  applyInput(predicted, input.keys);
  if (!wasDashing && predicted.dashTicks > 0) audio.dash(true, predicted.x);
  send({ type: "input", ...input });
};

const interpolatedPosition = (select, renderTime) => {
  for (let i = snapshots.length - 1; i > 0; i--) {
    const older = snapshots[i - 1];
    if (older.time > renderTime) continue;
    const newer = snapshots[i];
    const from = select(older);
    const to = select(newer);
    if (!from || !to) return to || from;
    const t = Math.min((renderTime - older.time) / (newer.time - older.time || 1), 1);
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }
  return snapshots[0] && select(snapshots[0]);
};

const playerView = (player, now) => {
  const isMe = player.id === playerId;
  const source = isMe && predicted ? predicted : player;
  const position = (isMe ? predicted : interpolatedPosition((snapshot) => snapshot.players.get(player.id), now - INTERPOLATION_DELAY_MS)) || player;
  const last = lastPositions.get(player.id);
  const moving = Boolean(last) && Math.hypot(position.x - last.x, position.y - last.y) > MOVING_THRESHOLD;
  lastPositions.set(player.id, { x: position.x, y: position.y });
  return { ...player, x: position.x, y: position.y, faceX: source.faceX, faceY: source.faceY, dashTicks: source.dashTicks, moving };
};

const buildView = (now) => {
  const players = latestState.players.map((player) => playerView(player, now));
  const me = players.find((player) => player.id === playerId);
  const spawner = latestState.spawner && (interpolatedPosition((snapshot) => snapshot.spawner, now - INTERPOLATION_DELAY_MS) || latestState.spawner);
  return {
    arena: latestState.arena,
    players,
    me: me && predicted ? { ...me, dashCharge: predicted.dashCharge } : null,
    aimAngle: mouseAimAngle(),
    coins: latestState.coins,
    spawner,
    blackHoles: latestState.blackHoles,
    traps: latestState.traps,
    chaosPickups: latestState.chaosPickups,
  };
};

const emitAmbientEffects = (view) => {
  trailToggle = !trailToggle;
  if (trailToggle) for (const player of view.players) if (player.dashTicks > 0) effects.dashTrail(player.x, player.y, player.radius, player.color);
  for (const hole of view.blackHoles) effects.blackHoleSuction(hole.x, hole.y, hole.radius, hole.draining);
};

const playStateSounds = (previous, state) => {
  for (const player of state.players) {
    const before = lastDashTicks.get(player.id) || 0;
    if (player.id !== playerId && before === 0 && player.dashTicks > 0) audio.dash(false, player.x);
    lastDashTicks.set(player.id, player.dashTicks);
  }
  const me = state.players.find((player) => player.id === playerId);
  if (me) {
    const progress = me.lock ? me.lock.progress : 0;
    if (progress > lastLockProgress) audio.lockStep();
    lastLockProgress = progress;
    audio.setTrapped(me.trapped);
  }
  if (previous && previous.phase === "playing" && state.phase !== "playing" && me) {
    const matchOver = state.phase === "matchOver";
    audio.roundEnd((matchOver ? state.matchWinner : state.roundWinner) === me.name, matchOver);
  }
  audio.setMusicLevel(musicLevelFor(state));
};

const receiveState = (state) => {
  const now = performance.now();
  playStateSounds(latestState, state);
  for (const event of state.events) audio.handleEvent(event, playerId);
  latestState = state;
  setArena(state.arena);
  for (const event of state.events) effects.handleEvent(event, playerId, now, world);
  snapshots.push({ time: now, spawner: state.spawner, players: new Map(state.players.map((player) => [player.id, player])) });
  snapshots = snapshots.filter((snapshot) => now - snapshot.time < SNAPSHOT_HISTORY_MS);
  reconcile(state);
};

const frame = (now) => {
  const elapsed = Math.min(now - lastFrameTime, 250);
  accumulator += elapsed;
  lastFrameTime = now;
  while (accumulator >= STEP_MS) {
    if (latestState) simulateStep();
    accumulator -= STEP_MS;
  }
  if (latestState) {
    const view = buildView(now);
    emitAmbientEffects(view);
    effects.update(Math.min(elapsed / 1000, 0.1));
    world.render(view, now, effects);
    hud.update(latestState, playerId, selectedPowerUp);
  }
  requestAnimationFrame(frame);
};

document.getElementById("join").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = document.getElementById("name").value;
  audio.unlock();
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  socket.onopen = () => send({ type: "join", name });
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.type === "welcome") {
      playerId = data.id;
      document.body.classList.add("in-game");
      requestAnimationFrame(frame);
    } else if (data.type === "state") {
      receiveState(data);
    }
  };
  socket.onclose = () => alert("Disconnected from server. Reload to rejoin.");
});
