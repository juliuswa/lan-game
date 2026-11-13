(function () {
  const MAX_PARTICLES = 900;
  const GOLD = ["#ffd700", "#ffec80", "#e6a800"];
  const PURPLE = ["#b47cff", "#7a3cff", "#e0c8ff"];
  const RED = ["#ff4d4d", "#c0392b", "#ffb3b3"];
  const DUST = ["#999", "#bbb", "#666"];

  const random = (min, max) => min + Math.random() * (max - min);
  const fade = (item) => Math.max(0, item.life / item.maxLife);

  window.createEffects = (ctx) => {
    let particles = [];
    let rings = [];
    let texts = [];
    let ghosts = [];
    let shake = 0;
    const flashes = new Map();

    const burst = ({ x, y, count, colors, speed, life, size, drag = 0.9, gravity = 0, directionX = 0, directionY = 0, spread = Math.PI * 2, inward = false }) => {
      const aimed = directionX || directionY;
      const baseAngle = Math.atan2(directionY, directionX);
      for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
        const angle = aimed ? baseAngle + random(-spread / 2, spread / 2) : random(0, Math.PI * 2);
        const velocity = random(speed * 0.35, speed);
        const startDistance = inward ? velocity * life * 0.6 : 0;
        particles.push({
          x: x + Math.cos(angle) * startDistance,
          y: y + Math.sin(angle) * startDistance,
          vx: Math.cos(angle) * velocity * (inward ? -1 : 1),
          vy: Math.sin(angle) * velocity * (inward ? -1 : 1),
          life: random(life * 0.6, life),
          maxLife: life,
          size: random(size * 0.5, size),
          color: colors[i % colors.length],
          drag,
          gravity,
        });
      }
    };

    const ring = (x, y, color, fromRadius, toRadius, life, width = 3) =>
      rings.push({ x, y, color, fromRadius, toRadius, life, maxLife: life, width });

    const floatText = (x, y, text, color, size = 18) => texts.push({ x, y, text, color, size, life: 0.9, maxLife: 0.9 });

    const addShake = (amount) => {
      shake = Math.max(shake, amount);
    };

    const flash = (id, now, duration = 150) => flashes.set(id, now + duration);

    const handlers = {
      hit: (event, myId, now) => {
        const involvesMe = event.attackerId === myId || event.victimId === myId;
        burst({ x: event.x, y: event.y, count: Math.round(16 * event.strength), colors: [event.color, "#fff", "#ffe680"], speed: 480, life: 0.45, size: 4, directionX: event.normalX, directionY: event.normalY, spread: 1.8 });
        burst({ x: event.x, y: event.y, count: 8, colors: ["#fff"], speed: 200, life: 0.3, size: 3 });
        ring(event.x, event.y, "#fff", 6, 46 * event.strength, 0.3, 4);
        floatText(event.x, event.y - 20, "BAM!", event.color, 20);
        flash(event.victimId, now);
        addShake(involvesMe ? 12 : 4);
      },
      spawnerHit: (event, myId) => {
        burst({ x: event.x, y: event.y, count: 14, colors: GOLD, speed: 380, life: 0.4, size: 4, directionX: event.normalX, directionY: event.normalY, spread: 1.6 });
        ring(event.x, event.y, "#ffd700", 6, 40, 0.3);
        addShake(event.attackerId === myId ? 6 : 2);
      },
      coin: (event, myId) => {
        burst({ x: event.x, y: event.y, count: 12, colors: GOLD, speed: 200, life: 0.5, size: 3 });
        ring(event.x, event.y, "#ffd700", 4, 22, 0.25, 2);
        floatText(event.playerX, event.playerY - 24, "+1", "#ffd700", event.playerId === myId ? 20 : 15);
      },
      coinSpawn: (event) => {
        ring(event.x, event.y, "#fff3a0", 18, 2, 0.3, 2);
        burst({ x: event.x, y: event.y, count: 5, colors: ["#fff3a0"], speed: 90, life: 0.35, size: 2 });
      },
      bonus: (event) => {
        burst({ x: event.x, y: event.y, count: 30, colors: GOLD, speed: 300, life: 0.7, size: 4, gravity: 300 });
        ring(event.x, event.y, "#ffd700", 10, 60, 0.4, 3);
        floatText(event.x, event.y - 30, `+${event.amount}`, "#ffd700", 26);
      },
      wallHit: (event, myId) => {
        burst({ x: event.x, y: event.y, count: 16, colors: DUST, speed: 260, life: 0.5, size: 4 });
        if (event.lost) floatText(event.x, event.y - 30, `-${event.lost}`, "#ff4d4d", 24);
        addShake(event.playerId === myId ? 10 : 3);
      },
      spawnerBreak: (event) => {
        burst({ x: event.x, y: event.y, count: 45, colors: [...GOLD, "#5a4510"], speed: 420, life: 0.9, size: 5, gravity: 500, drag: 0.94 });
        ring(event.x, event.y, "#ffd700", 20, 110, 0.5, 5);
        floatText(event.x, event.y - 40, "CRACK!", "#ffd700", 26);
        addShake(8);
      },
      spawnerSpawn: (event) => {
        ring(event.x, event.y, "#ffd700", 80, 28, 0.4, 3);
        burst({ x: event.x, y: event.y, count: 20, colors: GOLD, speed: 160, life: 0.5, size: 3, inward: true });
      },
      holeOpen: (event) => {
        ring(event.x, event.y, "#b47cff", 70, 10, 0.5, 3);
        burst({ x: event.x, y: event.y, count: 20, colors: PURPLE, speed: 140, life: 0.6, size: 3, inward: true });
      },
      holeClose: (event) => {
        burst({ x: event.x, y: event.y, count: 24, colors: PURPLE, speed: 240, life: 0.5, size: 3 });
        ring(event.x, event.y, "#b47cff", 5, 50, 0.35, 3);
      },
      teleport: (event, myId, now) => {
        burst({ x: event.fromX, y: event.fromY, count: 24, colors: [...PURPLE, event.color], speed: 160, life: 0.5, size: 4, inward: true });
        ring(event.toX, event.toY, event.color, 4, event.radius * 3, 0.4, 4);
        burst({ x: event.toX, y: event.toY, count: 20, colors: [...PURPLE, event.color], speed: 260, life: 0.5, size: 4 });
        flash(event.playerId, now, 250);
        if (event.playerId === myId) addShake(5);
      },
      trapDrop: (event) => {
        burst({ x: event.x, y: event.y, count: 8, colors: DUST, speed: 90, life: 0.4, size: 3 });
        ring(event.x, event.y, "#999", 4, 20, 0.3, 2);
      },
      trapSnap: (event, myId) => {
        burst({ x: event.x, y: event.y, count: 18, colors: RED, speed: 260, life: 0.45, size: 4 });
        ring(event.x, event.y, "#ff4d4d", event.radius + 30, event.radius, 0.3, 4);
        floatText(event.x, event.y - event.radius - 22, "TRAPPED!", "#ff4d4d", 18);
        addShake(event.playerId === myId ? 8 : 2);
      },
      playerSpawn: (event) => {
        ring(event.x, event.y, event.color, event.radius * 3, event.radius, 0.45, 3);
        burst({ x: event.x, y: event.y, count: 14, colors: [event.color, "#fff"], speed: 150, life: 0.45, size: 3, inward: true });
      },
    };

    const handleEvent = (event, myId, now) => {
      const handler = handlers[event.type];
      if (handler) handler(event, myId, now);
    };

    const dashTrail = (x, y, radius, color) => ghosts.push({ x, y, radius, color, life: 0.2, maxLife: 0.2 });

    const blackHoleSuction = (x, y, radius) => {
      if (Math.random() > 0.35 || particles.length >= MAX_PARTICLES) return;
      const angle = random(0, Math.PI * 2);
      const distance = radius * random(1.8, 2.6);
      const life = 0.6;
      particles.push({
        x: x + Math.cos(angle) * distance,
        y: y + Math.sin(angle) * distance,
        vx: (-Math.cos(angle) * distance) / life + -Math.sin(angle) * 60,
        vy: (-Math.sin(angle) * distance) / life + Math.cos(angle) * 60,
        life,
        maxLife: life,
        size: random(1.5, 3),
        color: PURPLE[Math.floor(Math.random() * PURPLE.length)],
        drag: 1,
        gravity: 0,
      });
    };

    const update = (dt) => {
      const frames = dt * 60;
      for (const particle of particles) {
        particle.life -= dt;
        const dragFactor = Math.pow(particle.drag, frames);
        particle.vx *= dragFactor;
        particle.vy = particle.vy * dragFactor + particle.gravity * dt;
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
      }
      particles = particles.filter((particle) => particle.life > 0);
      for (const item of [...rings, ...texts, ...ghosts]) item.life -= dt;
      rings = rings.filter((item) => item.life > 0);
      texts = texts.filter((item) => item.life > 0);
      ghosts = ghosts.filter((item) => item.life > 0);
      shake *= Math.pow(0.82, frames);
      if (shake < 0.3) shake = 0;
    };

    const shakeOffset = () => ({ x: random(-shake, shake), y: random(-shake, shake) });

    const flashAmount = (id, now) => {
      const until = flashes.get(id);
      if (!until || until < now) return 0;
      return Math.min(1, (until - now) / 150);
    };

    const drawGhosts = () => {
      for (const ghost of ghosts) {
        ctx.globalAlpha = fade(ghost) * 0.45;
        ctx.beginPath();
        ctx.arc(ghost.x, ghost.y, ghost.radius * (0.7 + 0.3 * fade(ghost)), 0, Math.PI * 2);
        ctx.fillStyle = ghost.color;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const draw = () => {
      for (const particle of particles) {
        ctx.globalAlpha = fade(particle);
        ctx.fillStyle = particle.color;
        const size = particle.size * (0.5 + 0.5 * fade(particle));
        ctx.fillRect(particle.x - size / 2, particle.y - size / 2, size, size);
      }
      for (const item of rings) {
        const progress = 1 - fade(item);
        const eased = 1 - Math.pow(1 - progress, 3);
        ctx.globalAlpha = fade(item);
        ctx.beginPath();
        ctx.arc(item.x, item.y, Math.max(0, item.fromRadius + (item.toRadius - item.fromRadius) * eased), 0, Math.PI * 2);
        ctx.lineWidth = item.width;
        ctx.strokeStyle = item.color;
        ctx.stroke();
      }
      ctx.textAlign = "center";
      for (const item of texts) {
        const progress = 1 - fade(item);
        const pop = progress < 0.15 ? 0.6 + (progress / 0.15) * 0.6 : 1.2 - Math.min(0.2, (progress - 0.15) * 0.5);
        ctx.globalAlpha = Math.min(1, fade(item) * 2);
        ctx.font = `bold ${Math.round(item.size * pop)}px system-ui`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        const y = item.y - progress * 30;
        ctx.strokeText(item.text, item.x, y);
        ctx.fillStyle = item.color;
        ctx.fillText(item.text, item.x, y);
      }
      ctx.globalAlpha = 1;
    };

    return { handleEvent, update, draw, drawGhosts, dashTrail, blackHoleSuction, shakeOffset, flashAmount };
  };
})();
