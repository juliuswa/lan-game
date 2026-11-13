import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "/vendor/CSS2DRenderer.js";
import { RoomEnvironment } from "/vendor/RoomEnvironment.js";

const { CONFIG } = window.Shared;
const CENTER_X = CONFIG.width / 2;
const CENTER_Y = CONFIG.height / 2;
const WALL_HEIGHT = 34;
const RAIL_HEIGHT = 16;
const FLOOR_DEPTH = 24;
const BASE_CAMERA = new THREE.Vector3(0, 760, 600);
const CAMERA_TARGET = new THREE.Vector3(0, 0, 40);
const COIN_POP_MS = 220;
const SPAWNER_POP_MS = 400;

export const toWorld = (x, y, height = 0) => new THREE.Vector3(x - CENTER_X, height, y - CENTER_Y);

const easeOutBack = (t) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
const popScale = (elapsedMs, durationMs) => (elapsedMs >= durationMs ? 1 : Math.max(0.001, easeOutBack(elapsedMs / durationMs)));
const lifeScale = (lifeLeft, growRate, shrinkRate) => Math.max(0.001, Math.min(1, (1 - lifeLeft) * growRate, lifeLeft * shrinkRate));

const CHAOS_STYLES = {
  swapPosition: { color: 0x46f0f0, icon: "⇄" },
  swapCoins: { color: 0xffd700, icon: "$" },
  lockdown: { color: 0xff4d4d, icon: "🔒" },
};

const makeLabel = (className, text = "") => {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  return new CSS2DObject(element);
};

const disposeTree = (object) => {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) [].concat(child.material).forEach((material) => material.dispose());
    if (child.isCSS2DObject) child.element.remove();
  });
};

const syncCollection = (scene, collection, items, keyOf, create, update) => {
  const seen = new Set();
  for (const item of items) {
    const key = keyOf(item);
    seen.add(key);
    let entry = collection.get(key);
    if (!entry) {
      entry = create(item);
      collection.set(key, entry);
      scene.add(entry.group);
    }
    update(entry, item);
  }
  for (const [key, entry] of collection) {
    if (seen.has(key)) continue;
    scene.remove(entry.group);
    disposeTree(entry.group);
    collection.delete(key);
  }
};

const floorTexture = () => {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  context.fillStyle = "#262a35";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#2c3140";
  context.fillRect(0, 0, size / 2, size / 2);
  context.fillRect(size / 2, size / 2, size / 2, size / 2);
  context.strokeStyle = "#3a4152";
  context.lineWidth = 3;
  context.strokeRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / 80, 1 / 80);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
};

const signedArea = (boundary) =>
  boundary.reduce((sum, [ax, ay], i) => {
    const [bx, by] = boundary[(i + 1) % boundary.length];
    return sum + ax * by - bx * ay;
  }, 0) / 2;

const buildArena = (arena) => {
  const group = new THREE.Group();
  const shape = new THREE.Shape(arena.boundary.map(([x, y]) => new THREE.Vector2(x - CENTER_X, -(y - CENTER_Y))));
  const floorGeometry = new THREE.ExtrudeGeometry(shape, { depth: FLOOR_DEPTH, bevelEnabled: false });
  floorGeometry.rotateX(-Math.PI / 2);
  floorGeometry.translate(0, -FLOOR_DEPTH, 0);
  const floor = new THREE.Mesh(floorGeometry, [
    new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.85, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({ color: 0x14161d, roughness: 0.9 }),
  ]);
  floor.receiveShadow = true;
  group.add(floor);

  const winding = Math.sign(signedArea(arena.boundary)) || 1;
  const railMaterial = new THREE.MeshStandardMaterial({ color: 0x2b3a5c, emissive: 0x16306a, emissiveIntensity: 0.9, roughness: 0.4 });
  arena.boundary.forEach(([ax, ay], i) => {
    const [bx, by] = arena.boundary[(i + 1) % arena.boundary.length];
    const length = Math.hypot(bx - ax, by - ay);
    const inwardX = (-(by - ay) / length) * winding;
    const inwardY = ((bx - ax) / length) * winding;
    const rail = new THREE.Mesh(new THREE.BoxGeometry(length + 6, RAIL_HEIGHT, 6), railMaterial);
    rail.position.copy(toWorld((ax + bx) / 2 - inwardX * 3, (ay + by) / 2 - inwardY * 3, RAIL_HEIGHT / 2));
    rail.rotation.y = -Math.atan2(by - ay, bx - ax);
    rail.castShadow = true;
    group.add(rail);
  });

  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x5b6273, roughness: 0.55, metalness: 0.35 });
  const dangerMaterial = new THREE.MeshStandardMaterial({ color: 0xff5533, emissive: 0xff3311, emissiveIntensity: 1.2 });
  for (const wall of arena.walls) {
    const block = new THREE.Mesh(new THREE.BoxGeometry(wall.w, WALL_HEIGHT, wall.h), wallMaterial);
    block.position.copy(toWorld(wall.x + wall.w / 2, wall.y + wall.h / 2, WALL_HEIGHT / 2));
    block.castShadow = true;
    block.receiveShadow = true;
    group.add(block);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(wall.w + 5, 4, wall.h + 5), dangerMaterial);
    strip.position.copy(toWorld(wall.x + wall.w / 2, wall.y + wall.h / 2, 2));
    group.add(strip);
  }
  return group;
};

const createPlayerEntity = (player) => {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: player.color, roughness: 0.35, metalness: 0.1, transparent: true });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), material);
  body.castShadow = true;
  const face = new THREE.Group();
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
  const pupilMaterial = new THREE.MeshStandardMaterial({ color: 0x111111 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), eyeMaterial);
    eye.position.set(0.78, 0.3, side * 0.32);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), pupilMaterial);
    pupil.position.set(0.98, 0.3, side * 0.32);
    face.add(eye, pupil);
  }
  const avatar = new THREE.Group();
  avatar.add(body, face);
  const shadowDisc = new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }));
  shadowDisc.rotation.x = -Math.PI / 2;
  shadowDisc.position.y = 0.4;
  const cage = new THREE.Group();
  const barMaterial = new THREE.MeshStandardMaterial({ color: 0xc0392b, emissive: 0x801010, metalness: 0.6, roughness: 0.3 });
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6), barMaterial);
    bar.position.set(Math.cos(angle) * 1.25, 1.3, Math.sin(angle) * 1.25);
    cage.add(bar);
  }
  const cageRing = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.08, 8, 32), barMaterial);
  cageRing.rotation.x = Math.PI / 2;
  cageRing.position.y = 2.6;
  cage.add(cageRing);
  cage.visible = false;
  const nameLabel = makeLabel("name-label", player.name);
  const lockLabel = makeLabel("lock-label");
  lockLabel.visible = false;
  group.add(avatar, shadowDisc, cage, nameLabel, lockLabel);
  return { group, avatar, face, body, material, shadowDisc, cage, nameLabel, lockLabel, lockKey: "" };
};

const renderLock = (element, lock) => {
  element.replaceChildren(
    ...lock.combo.map((key, index) => {
      const box = document.createElement("span");
      box.textContent = key.toUpperCase();
      box.className = index < lock.progress ? "done" : index === lock.progress ? "current" : "";
      return box;
    }),
  );
};

const createCoinEntity = () => {
  const group = new THREE.Group();
  const coin = new THREE.Mesh(
    new THREE.CylinderGeometry(CONFIG.coinRadius, CONFIG.coinRadius, 3, 28),
    new THREE.MeshStandardMaterial({ color: 0xffcc33, metalness: 1, roughness: 0.25, emissive: 0x664400, emissiveIntensity: 0.6 }),
  );
  coin.rotation.x = Math.PI / 2;
  coin.castShadow = true;
  const spinner = new THREE.Group();
  spinner.add(coin);
  group.add(spinner);
  return { group, spinner, bornAt: performance.now(), phase: Math.random() * Math.PI * 2 };
};

const createSpawnerEntity = () => {
  const group = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: 0xd4a017, metalness: 1, roughness: 0.3, emissive: 0x3a2500 });
  const r = CONFIG.spawnerRadius;
  const profile = [
    [0, 0], [r * 0.55, 0], [r * 0.85, r * 0.2], [r, r * 0.6], [r * 0.95, r * 1.0], [r * 0.75, r * 1.25], [r * 0.8, r * 1.35], [r * 0.7, r * 1.35],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const pot = new THREE.Mesh(new THREE.LatheGeometry(profile, 40), gold);
  pot.castShadow = true;
  const glow = new THREE.Mesh(new THREE.CircleGeometry(r * 0.72, 32), new THREE.MeshBasicMaterial({ color: 0xffe066 }));
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = r * 1.2;
  const coinMaterial = new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 1, roughness: 0.25, emissive: 0x553300 });
  for (let i = 0; i < 6; i++) {
    const coin = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 2, 16), coinMaterial);
    const angle = (i / 6) * Math.PI * 2;
    coin.position.set(Math.cos(angle) * r * 0.35, r * 1.28 + (i % 2) * 3, Math.sin(angle) * r * 0.35);
    coin.rotation.set(Math.random() * 0.6, 0, Math.random() * 0.6);
    pot.add(coin);
  }
  const light = new THREE.PointLight(0xffc040, 1.6, 220, 1.6);
  light.position.y = r * 1.6;
  const wobble = new THREE.Group();
  wobble.add(pot, glow, light);
  group.add(wobble);
  return { group, wobble, light };
};

const createHoleEntity = (hole) => {
  const group = new THREE.Group();
  const tint = hole.draining ? 0xff2a2a : 0x9a4dff;
  const pit = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  pit.rotation.x = -Math.PI / 2;
  pit.position.y = 0.6;
  const rings = [];
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9 + i * 0.25, 1.0 + i * 0.25, 48, 1, 0, Math.PI * 1.2),
      new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.85 - i * 0.2, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.8 + i * 0.2;
    rings.push(ring);
    group.add(ring);
  }
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(1.9, 40),
    new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.5;
  const light = new THREE.PointLight(tint, 1.2, 160, 1.8);
  light.position.y = 20;
  group.add(halo, pit, light);
  return { group, rings };
};

const createTrapEntity = (trap) => {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a8f99, metalness: 0.9, roughness: 0.35 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(trap.radius, trap.radius, 2, 24), metal);
  base.position.y = 1;
  base.castShadow = true;
  group.add(base);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(1.6, 7, 6), metal);
    spike.position.set(Math.cos(angle) * trap.radius * 0.8, 5, Math.sin(angle) * trap.radius * 0.8);
    spike.rotation.set(Math.sin(angle) * -0.35, 0, Math.cos(angle) * 0.35);
    spike.castShadow = true;
    group.add(spike);
  }
  const trigger = new THREE.Mesh(new THREE.SphereGeometry(trap.radius * 0.32, 16, 10), new THREE.MeshStandardMaterial({ color: 0xc0392b, emissive: 0xaa1010, emissiveIntensity: 1.2 }));
  trigger.position.y = 3;
  group.add(trigger);
  return { group, trigger };
};

const createPickupEntity = (pickup) => {
  const group = new THREE.Group();
  const style = CHAOS_STYLES[pickup.kind];
  const gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(pickup.radius, 0),
    new THREE.MeshStandardMaterial({ color: style.color, emissive: style.color, emissiveIntensity: 0.7, metalness: 0.3, roughness: 0.2, transparent: true }),
  );
  gem.castShadow = true;
  const shell = new THREE.Mesh(new THREE.OctahedronGeometry(pickup.radius * 1.35, 0), new THREE.MeshBasicMaterial({ color: style.color, wireframe: true, transparent: true, opacity: 0.6 }));
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(pickup.radius * 2.4, 32),
    new THREE.MeshBasicMaterial({ color: style.color, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.7;
  const icon = makeLabel("pickup-icon", style.icon);
  icon.element.style.color = `#${style.color.toString(16).padStart(6, "0")}`;
  const floating = new THREE.Group();
  floating.add(gem, shell, icon);
  icon.position.y = pickup.radius * 2.6;
  group.add(floating, glow);
  return { group, floating, gem, shell, glow, icon };
};

const createAimArrow = () => {
  const shape = new THREE.Shape();
  shape.moveTo(0, -2.5);
  shape.lineTo(26, -2.5);
  shape.lineTo(26, -8);
  shape.lineTo(40, 0);
  shape.lineTo(26, 8);
  shape.lineTo(26, 2.5);
  shape.lineTo(0, 2.5);
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  const arrow = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }));
  arrow.position.y = 1.5;
  return arrow;
};

const chargeRingGeometries = Array.from({ length: CONFIG.dashCoinCost + 1 }, (_, charge) =>
  new THREE.RingGeometry(1.25, 1.42, 48, 1, Math.PI / 2, Math.max(0.0001, (Math.PI * 2 * charge) / CONFIG.dashCoinCost)),
);

export const createWorld = (container) => {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = "label-layer";
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07080d);
  scene.fog = new THREE.Fog(0x07080d, 1300, 2800);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;

  const camera = new THREE.PerspectiveCamera(40, 1, 1, 6000);
  let cameraBase = BASE_CAMERA.clone();

  scene.add(new THREE.HemisphereLight(0x8fa8ff, 0x1a1208, 0.7));
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.4);
  sun.position.set(-320, 700, 260);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -560, right: 560, top: 460, bottom: -460, near: 100, far: 1800 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const voidGrid = new THREE.GridHelper(4000, 80, 0x1c2540, 0x111726);
  voidGrid.position.y = -120;
  scene.add(voidGrid);

  const players = new Map();
  const coins = new Map();
  const holes = new Map();
  const traps = new Map();
  const pickups = new Map();
  let arenaGroup = null;
  let arenaKey = "";
  let spawner = null;
  let spawnerAppearedAt = 0;
  let spawnerWobbleUntil = 0;

  const myRing = new THREE.Mesh(chargeRingGeometries[0], new THREE.MeshBasicMaterial({ color: 0x46f0f0, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  myRing.rotation.x = -Math.PI / 2;
  const myMarker = new THREE.Mesh(new THREE.RingGeometry(1.08, 1.18, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  myMarker.rotation.x = -Math.PI / 2;
  const aimArrow = createAimArrow();
  scene.add(myRing, myMarker, aimArrow);

  const resize = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    renderer.setSize(width, height);
    labelRenderer.setSize(width, height);
    camera.aspect = width / height;
    const fit = Math.max(1, 1.5 / camera.aspect);
    cameraBase = CAMERA_TARGET.clone().add(BASE_CAMERA.clone().sub(CAMERA_TARGET).multiplyScalar(fit));
    camera.updateProjectionMatrix();
  };
  resize();
  addEventListener("resize", resize);

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const toGame = (clientX, clientY) => {
    const bounds = renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((clientX - bounds.left) / bounds.width) * 2 - 1, -((clientY - bounds.top) / bounds.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
    return { x: hit.x + CENTER_X, y: hit.z + CENTER_Y };
  };

  const syncArena = (arena) => {
    const key = JSON.stringify(arena);
    if (key === arenaKey) return;
    arenaKey = key;
    if (arenaGroup) {
      scene.remove(arenaGroup);
      disposeTree(arenaGroup);
    }
    arenaGroup = buildArena(arena);
    scene.add(arenaGroup);
  };

  const syncPlayers = (view, now, flashAmount) => {
    syncCollection(scene, players, view.players, (player) => player.id, createPlayerEntity, (entity, player) => {
      const r = player.radius;
      entity.group.position.copy(toWorld(player.x, player.y));
      const dashing = player.dashTicks > 0;
      const bounce = dashing ? 0 : Math.abs(Math.sin(now / 110 + Number(player.id))) * (player.moving ? r * 0.18 : 0);
      entity.avatar.position.y = r + bounce;
      entity.avatar.rotation.y = -Math.atan2(player.faceY, player.faceX);
      entity.avatar.scale.set(r * (dashing ? 1.35 : 1), r * (dashing ? 0.8 : 1), r * (dashing ? 0.85 : 1));
      entity.shadowDisc.scale.setScalar(r * 0.95);
      entity.material.opacity = player.hurt && Math.floor(now / 100) % 2 ? 0.35 : 1;
      const flash = flashAmount(player.id, now);
      entity.material.emissive.setRGB(flash, flash, flash);
      entity.nameLabel.position.y = r * 2 + 16;
      entity.cage.visible = player.trapped;
      entity.cage.scale.setScalar(r);
      entity.lockLabel.visible = Boolean(player.trapped && player.lock);
      entity.lockLabel.position.y = r * 2 + 44;
      if (player.lock) {
        const lockKey = `${player.lock.combo.join("")}:${player.lock.progress}`;
        if (lockKey !== entity.lockKey) {
          entity.lockKey = lockKey;
          renderLock(entity.lockLabel.element, player.lock);
        }
      }
    });
  };

  const syncMine = (me, aimAngle) => {
    myRing.visible = Boolean(me);
    myMarker.visible = Boolean(me);
    aimArrow.visible = false;
    if (!me) return;
    const position = toWorld(me.x, me.y, 1.2);
    myRing.position.copy(position);
    myMarker.position.copy(position);
    myRing.scale.setScalar(me.radius);
    myMarker.scale.setScalar(me.radius);
    const charge = Math.min(me.dashCharge, CONFIG.dashCoinCost);
    myRing.geometry = chargeRingGeometries[charge];
    myRing.material.opacity = charge >= CONFIG.dashCoinCost ? 1 : 0.45;
    if (charge >= CONFIG.dashCoinCost && aimAngle !== undefined && !me.trapped) {
      aimArrow.visible = true;
      aimArrow.position.copy(toWorld(me.x + Math.cos(aimAngle) * (me.radius + 6), me.y + Math.sin(aimAngle) * (me.radius + 6), 1.5));
      aimArrow.rotation.y = -aimAngle;
    }
  };

  const syncCoins = (coinList, now) => {
    syncCollection(scene, coins, coinList, (coin) => `${Math.round(coin.x)},${Math.round(coin.y)}`, createCoinEntity, (entity, coin) => {
      const scale = popScale(now - entity.bornAt, COIN_POP_MS);
      entity.group.position.copy(toWorld(coin.x, coin.y, CONFIG.coinRadius + 3 + Math.sin(now / 300 + entity.phase) * 3));
      entity.group.scale.setScalar(scale);
      entity.spinner.rotation.y = now / 400 + entity.phase;
    });
  };

  const syncSpawner = (position, now) => {
    if (!position) {
      if (spawner) {
        scene.remove(spawner.group);
        disposeTree(spawner.group);
        spawner = null;
      }
      return;
    }
    if (!spawner) {
      spawner = createSpawnerEntity();
      spawnerAppearedAt = now;
      scene.add(spawner.group);
    }
    spawner.group.position.copy(toWorld(position.x, position.y));
    spawner.group.scale.setScalar(popScale(now - spawnerAppearedAt, SPAWNER_POP_MS));
    spawner.group.rotation.y = now / 2000;
    const wobble = spawnerWobbleUntil > now ? Math.sin(now / 30) * 0.25 * ((spawnerWobbleUntil - now) / 500) : 0;
    spawner.wobble.rotation.z = wobble;
    spawner.light.intensity = 1.4 + Math.sin(now / 200) * 0.3;
  };

  const syncHoles = (holeList, now) => {
    syncCollection(scene, holes, holeList, (hole) => `${Math.round(hole.x)},${Math.round(hole.y)}`, createHoleEntity, (entity, hole) => {
      entity.group.position.copy(toWorld(hole.x, hole.y));
      entity.group.scale.setScalar(hole.radius * lifeScale(hole.lifeLeft, 20, 8));
      entity.rings.forEach((ring, index) => {
        ring.rotation.z = (now / (220 + index * 90)) * (index % 2 ? -1 : 1);
      });
    });
  };

  const syncTraps = (trapList, now) => {
    syncCollection(scene, traps, trapList, (trap) => `${Math.round(trap.x)},${Math.round(trap.y)}`, createTrapEntity, (entity, trap) => {
      entity.group.position.copy(toWorld(trap.x, trap.y));
      entity.trigger.material.emissiveIntensity = 0.8 + Math.sin(now / 150) * 0.6;
    });
  };

  const syncPickups = (pickupList, now) => {
    syncCollection(scene, pickups, pickupList, (pickup) => `${pickup.kind}:${Math.round(pickup.x)},${Math.round(pickup.y)}`, createPickupEntity, (entity, pickup) => {
      const scale = lifeScale(pickup.lifeLeft, 25, 10);
      const blink = pickup.lifeLeft < 0.2 && Math.floor(now / 120) % 2 ? 0.35 : 1;
      entity.group.position.copy(toWorld(pickup.x, pickup.y));
      entity.floating.position.y = 26 + Math.sin(now / 250) * 5;
      entity.floating.scale.setScalar(scale);
      entity.gem.rotation.y = now / 500;
      entity.shell.rotation.y = -now / 700;
      entity.shell.rotation.x = now / 900;
      entity.gem.material.opacity = blink;
      entity.glow.material.opacity = 0.3 * blink * (1 + 0.3 * Math.sin(now / 150));
      entity.icon.element.style.opacity = blink;
    });
  };

  const render = (view, now, effects) => {
    syncArena(view.arena);
    syncPlayers(view, now, effects.flashAmount);
    syncMine(view.me, view.aimAngle);
    syncCoins(view.coins, now);
    syncSpawner(view.spawner, now);
    syncHoles(view.blackHoles, now);
    syncTraps(view.traps, now);
    syncPickups(view.chaosPickups, now);
    const shake = effects.shakeOffset();
    camera.position.copy(cameraBase).add(new THREE.Vector3(shake.x, shake.y * 0.5, shake.y));
    camera.lookAt(CAMERA_TARGET.clone().add(new THREE.Vector3(shake.x * 0.5, 0, shake.y * 0.5)));
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  };

  const wobbleSpawner = (now) => {
    spawnerWobbleUntil = now + 500;
  };

  return { scene, camera, toGame, render, wobbleSpawner };
};
