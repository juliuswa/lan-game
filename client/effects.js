import * as THREE from "three";
import { CSS2DObject } from "/vendor/CSS2DRenderer.js";
import { toWorld } from "./world.js";

const MAX_PARTICLES = 2500;
const GOLD = [0xffd700, 0xffec80, 0xe6a800];
const PURPLE = [0xb47cff, 0x7a3cff, 0xe0c8ff];
const BLOOD = [0xff3b3b, 0xa80000, 0xffb3b3];
const RED = [0xff4d4d, 0xc0392b, 0xffb3b3];
const DUST = [0x999999, 0xbbbbbb, 0x666666];
const CHAOS = {
  swapPosition: { color: 0x46f0f0, label: "SWAP!" },
  swapCoins: { color: 0xffd700, label: "COIN SWAP!" },
  lockdown: { color: 0xff4d4d, label: "LOCKDOWN!" },
};

const holeColors = (draining) => (draining ? BLOOD : PURPLE);
const random = (min, max) => min + Math.random() * (max - min);
const cssColor = (hex) => `#${new THREE.Color(hex).getHexString()}`;

const PARTICLE_VERTEX = `
  attribute float size;
  attribute vec4 tint;
  varying vec4 vTint;
  void main() {
    vTint = tint;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (900.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const PARTICLE_FRAGMENT = `
  varying vec4 vTint;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vTint.rgb, vTint.a * smoothstep(0.5, 0.1, d));
  }
`;

export const createEffects = (scene) => {
  const positions = new Float32Array(MAX_PARTICLES * 3);
  const tints = new Float32Array(MAX_PARTICLES * 4);
  const sizes = new Float32Array(MAX_PARTICLES);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("tint", new THREE.BufferAttribute(tints, 4).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage));
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({ vertexShader: PARTICLE_VERTEX, fragmentShader: PARTICLE_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  points.frustumCulled = false;
  scene.add(points);

  let particles = [];
  let transients = [];
  let shake = 0;
  const flashes = new Map();

  const spawnParticle = (particle) => {
    if (particles.length < MAX_PARTICLES) particles.push(particle);
  };

  const burst = ({ x, y, height = 10, count, colors, speed, life, size, rise = 0.6, gravity = 500, drag = 0.92, directionX = 0, directionY = 0, spread = Math.PI * 2, inward = false }) => {
    const aimed = directionX || directionY;
    const baseAngle = Math.atan2(directionY, directionX);
    const origin = toWorld(x, y, height);
    for (let i = 0; i < count; i++) {
      const angle = aimed ? baseAngle + random(-spread / 2, spread / 2) : random(0, Math.PI * 2);
      const velocity = random(speed * 0.35, speed);
      const vertical = random(0.2, 1) * speed * rise;
      const particleLife = random(life * 0.6, life);
      const color = new THREE.Color(colors[i % colors.length]);
      const vx = Math.cos(angle) * velocity;
      const vz = Math.sin(angle) * velocity;
      const start = inward ? origin.clone().add(new THREE.Vector3(vx, vertical * 0.4, vz).multiplyScalar(particleLife * 0.6)) : origin.clone();
      spawnParticle({
        position: start,
        velocity: inward ? new THREE.Vector3(-vx, -vertical * 0.4, -vz) : new THREE.Vector3(vx, vertical, vz),
        life: particleLife,
        maxLife: particleLife,
        size: random(size * 0.5, size),
        color,
        gravity: inward ? 0 : gravity,
        drag,
      });
    }
  };

  const addTransient = (object, life, update) => {
    scene.add(object);
    transients.push({ object, life, maxLife: life, update });
  };

  const ring = (x, y, color, fromRadius, toRadius, life, width = 3, height = 2) => {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(1 - width / Math.max(fromRadius, toRadius, 1), 1, 64),
      new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(toWorld(x, y, height));
    addTransient(mesh, life, (progress) => {
      const eased = 1 - Math.pow(1 - progress, 3);
      mesh.scale.setScalar(Math.max(0.01, fromRadius + (toRadius - fromRadius) * eased));
      mesh.material.opacity = 1 - progress;
    });
  };

  const beam = (ax, ay, bx, by, color) => {
    const from = toWorld(ax, ay, 14);
    const to = toWorld(bx, by, 14);
    const length = from.distanceTo(to);
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, length, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    mesh.position.copy(from.clone().add(to).multiplyScalar(0.5));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    addTransient(mesh, 0.45, (progress) => {
      const thickness = 1 + 5 * (1 - progress);
      mesh.scale.set(thickness, 1, thickness);
      mesh.material.opacity = 1 - progress;
    });
  };

  const floatText = (x, y, text, color, size = 18, height = 50) => {
    const element = document.createElement("div");
    const inner = document.createElement("span");
    inner.className = "float-text";
    inner.textContent = text;
    inner.style.color = typeof color === "number" ? cssColor(color) : color;
    inner.style.fontSize = `${size}px`;
    element.appendChild(inner);
    const label = new CSS2DObject(element);
    const start = toWorld(x, y, height);
    label.position.copy(start);
    addTransient(label, 1, (progress) => {
      label.position.y = start.y + progress * 45;
      const pop = progress < 0.15 ? 0.6 + (progress / 0.15) * 0.6 : 1.2 - Math.min(0.2, (progress - 0.15) * 0.5);
      inner.style.transform = `scale(${pop})`;
      inner.style.opacity = String(Math.min(1, (1 - progress) * 2));
    });
  };

  const ghost = (x, y, radius, color) => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 16, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    mesh.position.copy(toWorld(x, y, radius));
    addTransient(mesh, 0.22, (progress) => {
      mesh.material.opacity = 0.4 * (1 - progress);
      mesh.scale.setScalar(1 - progress * 0.4);
    });
  };

  const addShake = (amount) => {
    shake = Math.max(shake, amount);
  };

  const flash = (id, now, duration = 150) => flashes.set(id, now + duration);

  const handlers = {
    hit: (event, myId, now) => {
      burst({ x: event.x, y: event.y, height: 16, count: Math.round(22 * event.strength), colors: [new THREE.Color(event.color).getHex(), 0xffffff, 0xffe680], speed: 520, life: 0.5, size: 7, directionX: event.normalX, directionY: event.normalY, spread: 1.8 });
      burst({ x: event.x, y: event.y, height: 16, count: 10, colors: [0xffffff], speed: 220, life: 0.3, size: 5 });
      ring(event.x, event.y, 0xffffff, 6, 50 * event.strength, 0.3, 4);
      floatText(event.x, event.y, "BAM!", event.color, 22);
      flash(event.victimId, now);
      addShake(event.attackerId === myId || event.victimId === myId ? 14 : 5);
    },
    spawnerHit: (event, myId, now, world) => {
      burst({ x: event.x, y: event.y, height: 20, count: 18, colors: GOLD, speed: 420, life: 0.45, size: 6, directionX: event.normalX, directionY: event.normalY, spread: 1.6 });
      ring(event.x, event.y, 0xffd700, 6, 44, 0.3);
      world.wobbleSpawner(now);
      addShake(event.attackerId === myId ? 7 : 2);
    },
    coin: (event, myId) => {
      burst({ x: event.x, y: event.y, height: 12, count: 14, colors: GOLD, speed: 220, life: 0.55, size: 5, rise: 1.2 });
      ring(event.x, event.y, 0xffd700, 4, 24, 0.25, 2);
      floatText(event.playerX, event.playerY, "+1", 0xffd700, event.playerId === myId ? 22 : 16);
    },
    coinSpawn: (event) => {
      ring(event.x, event.y, 0xfff3a0, 18, 2, 0.3, 2);
      burst({ x: event.x, y: event.y, height: 12, count: 6, colors: [0xfff3a0], speed: 90, life: 0.35, size: 4 });
    },
    wallHit: (event, myId) => {
      burst({ x: event.x, y: event.y, height: 14, count: 22, colors: DUST, speed: 280, life: 0.6, size: 7, rise: 1 });
      if (event.lost) floatText(event.x, event.y, `-${event.lost}`, 0xff4d4d, 26);
      addShake(event.playerId === myId ? 12 : 4);
    },
    spawnerBreak: (event) => {
      burst({ x: event.x, y: event.y, height: 25, count: 70, colors: [...GOLD, 0x8a6a10], speed: 460, life: 1.1, size: 8, rise: 1.4, gravity: 700 });
      ring(event.x, event.y, 0xffd700, 20, 120, 0.5, 6);
      floatText(event.x, event.y, "CRACK!", 0xffd700, 28, 70);
      addShake(10);
    },
    spawnerSpawn: (event) => {
      ring(event.x, event.y, 0xffd700, 90, 28, 0.4, 4);
      burst({ x: event.x, y: event.y, height: 25, count: 28, colors: GOLD, speed: 180, life: 0.5, size: 5, inward: true });
    },
    holeOpen: (event) => {
      ring(event.x, event.y, holeColors(event.draining)[0], 80, 10, 0.5, 4);
      burst({ x: event.x, y: event.y, height: 6, count: 26, colors: holeColors(event.draining), speed: 160, life: 0.6, size: 5, inward: true });
    },
    holeClose: (event) => {
      burst({ x: event.x, y: event.y, height: 6, count: 30, colors: holeColors(event.draining), speed: 260, life: 0.55, size: 5, rise: 1.2 });
      ring(event.x, event.y, holeColors(event.draining)[0], 5, 55, 0.35, 4);
    },
    teleport: (event, myId, now) => {
      burst({ x: event.fromX, y: event.fromY, height: 12, count: 30, colors: [...holeColors(event.draining), new THREE.Color(event.color).getHex()], speed: 180, life: 0.5, size: 6, inward: true });
      ring(event.toX, event.toY, new THREE.Color(event.color).getHex(), 4, event.radius * 3, 0.4, 4);
      burst({ x: event.toX, y: event.toY, height: 12, count: 26, colors: [...holeColors(event.draining), new THREE.Color(event.color).getHex()], speed: 280, life: 0.5, size: 6, rise: 1.4 });
      if (event.lost) floatText(event.toX, event.toY, `-${event.lost}`, 0xff4d4d, 26);
      flash(event.playerId, now, 250);
      if (event.playerId === myId) addShake(6);
    },
    trapDrop: (event) => {
      burst({ x: event.x, y: event.y, height: 4, count: 10, colors: DUST, speed: 110, life: 0.45, size: 5 });
      ring(event.x, event.y, 0x999999, 4, 22, 0.3, 2);
    },
    trapSnap: (event, myId) => {
      burst({ x: event.x, y: event.y, height: 10, count: 22, colors: RED, speed: 280, life: 0.5, size: 6, rise: 1 });
      ring(event.x, event.y, 0xff4d4d, event.radius + 34, event.radius, 0.3, 4);
      floatText(event.x, event.y, "TRAPPED!", 0xff4d4d, 18, 80);
      addShake(event.playerId === myId ? 9 : 2);
    },
    unlockFail: (event, myId, now) => {
      burst({ x: event.x, y: event.y, height: 20, count: 10, colors: RED, speed: 180, life: 0.3, size: 5 });
      floatText(event.x, event.y, "WRONG!", 0xff4d4d, 16, 95);
      flash(event.playerId, now, 120);
      if (event.playerId === myId) addShake(5);
    },
    unlockSuccess: (event) => {
      burst({ x: event.x, y: event.y, height: 16, count: 30, colors: [new THREE.Color(event.color).getHex(), 0x2ecc71, 0xffffff], speed: 320, life: 0.55, size: 6, rise: 1.3 });
      ring(event.x, event.y, 0x2ecc71, event.radius, event.radius * 3, 0.35, 4);
      floatText(event.x, event.y, "FREE!", 0x2ecc71, 20, 70);
    },
    chaosSpawn: (event) => {
      const { color } = CHAOS[event.kind];
      ring(event.x, event.y, color, 55, 14, 0.4, 3);
      burst({ x: event.x, y: event.y, height: 26, count: 18, colors: [color, 0xffffff], speed: 160, life: 0.5, size: 5, inward: true });
    },
    chaosExpire: (event) => {
      burst({ x: event.x, y: event.y, height: 26, count: 16, colors: [CHAOS[event.kind].color, 0x555555], speed: 140, life: 0.45, size: 5 });
    },
    chaosPickup: (event, myId) => {
      const { color, label } = CHAOS[event.kind];
      burst({ x: event.x, y: event.y, height: 26, count: 40, colors: [color, 0xffffff], speed: 360, life: 0.65, size: 7, rise: 1.2 });
      ring(event.x, event.y, color, 10, 90, 0.45, 5);
      floatText(event.x, event.y, label, color, 26, 60);
      addShake(event.playerId === myId ? 7 : 3);
    },
    chaosSwapPosition: (event, myId, now) => {
      for (const [x, y, color, id] of [[event.ax, event.ay, event.aColor, event.aId], [event.bx, event.by, event.bColor, event.bId]]) {
        ring(x, y, 0x46f0f0, 55, 10, 0.4, 3);
        burst({ x, y, height: 14, count: 24, colors: [0x46f0f0, new THREE.Color(color).getHex(), 0xffffff], speed: 240, life: 0.5, size: 6, rise: 1.2 });
        flash(id, now, 250);
      }
      beam(event.ax, event.ay, event.bx, event.by, 0x46f0f0);
      if (event.aId === myId || event.bId === myId) addShake(7);
    },
    chaosSwapCoins: (event, myId) => {
      for (const [x, y, delta, id] of [[event.ax, event.ay, event.aDelta, event.aId], [event.bx, event.by, event.bDelta, event.bId]]) {
        floatText(x, y, delta >= 0 ? `+${delta}` : `${delta}`, delta >= 0 ? 0xffd700 : 0xff4d4d, id === myId ? 28 : 22);
        burst({ x, y, height: 14, count: 22, colors: GOLD, speed: 240, life: 0.55, size: 6, rise: 1.2 });
      }
      beam(event.ax, event.ay, event.bx, event.by, 0xffd700);
      if (event.aId === myId || event.bId === myId) addShake(6);
    },
    roundStart: () => {
      floatText(400, 300, "GO!", 0x2ecc71, 72, 40);
      addShake(5);
    },
    playerSpawn: (event) => {
      ring(event.x, event.y, new THREE.Color(event.color).getHex(), event.radius * 3, event.radius, 0.45, 3);
      burst({ x: event.x, y: event.y, height: 14, count: 18, colors: [new THREE.Color(event.color).getHex(), 0xffffff], speed: 170, life: 0.45, size: 5, inward: true });
    },
  };

  const handleEvent = (event, myId, now, world) => {
    const handler = handlers[event.type];
    if (handler) handler(event, myId, now, world);
  };

  const blackHoleSuction = (x, y, radius, draining) => {
    if (Math.random() > 0.5) return;
    const colors = holeColors(draining);
    const angle = random(0, Math.PI * 2);
    const distance = radius * random(1.8, 2.8);
    const life = 0.6;
    const start = toWorld(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance, random(4, 20));
    const swirl = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle)).multiplyScalar(70);
    spawnParticle({
      position: start,
      velocity: new THREE.Vector3((-Math.cos(angle) * distance) / life, -start.y / life, (-Math.sin(angle) * distance) / life).add(swirl),
      life,
      maxLife: life,
      size: random(3, 5),
      color: new THREE.Color(colors[Math.floor(Math.random() * colors.length)]),
      gravity: 0,
      drag: 1,
    });
  };

  const update = (dt) => {
    const frames = dt * 60;
    for (const particle of particles) {
      particle.life -= dt;
      const dragFactor = Math.pow(particle.drag, frames);
      particle.velocity.x *= dragFactor;
      particle.velocity.z *= dragFactor;
      particle.velocity.y = particle.velocity.y * dragFactor - particle.gravity * dt;
      particle.position.addScaledVector(particle.velocity, dt);
      if (particle.position.y < 1 && particle.gravity > 0) {
        particle.position.y = 1;
        particle.velocity.y *= -0.35;
      }
    }
    particles = particles.filter((particle) => particle.life > 0);
    particles.forEach((particle, index) => {
      const fade = particle.life / particle.maxLife;
      positions.set([particle.position.x, particle.position.y, particle.position.z], index * 3);
      tints.set([particle.color.r, particle.color.g, particle.color.b, fade], index * 4);
      sizes[index] = particle.size * (0.5 + 0.5 * fade);
    });
    geometry.setDrawRange(0, particles.length);
    for (const name of ["position", "tint", "size"]) geometry.attributes[name].needsUpdate = true;

    for (const transient of transients) {
      transient.life -= dt;
      transient.update(Math.min(1, 1 - transient.life / transient.maxLife));
    }
    for (const transient of transients.filter((item) => item.life <= 0)) {
      scene.remove(transient.object);
      if (transient.object.geometry) transient.object.geometry.dispose();
      if (transient.object.material) transient.object.material.dispose();
      if (transient.object.isCSS2DObject) transient.object.element.remove();
    }
    transients = transients.filter((item) => item.life > 0);

    shake *= Math.pow(0.82, frames);
    if (shake < 0.3) shake = 0;
  };

  const shakeOffset = () => ({ x: random(-shake, shake), y: random(-shake, shake) });

  const flashAmount = (id, now) => {
    const until = flashes.get(id);
    if (!until || until < now) return 0;
    return Math.min(1, (until - now) / 150);
  };

  return { handleEvent, update, shakeOffset, flashAmount, dashTrail: ghost, blackHoleSuction };
};
