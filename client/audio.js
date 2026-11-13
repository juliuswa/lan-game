const { CONFIG } = window.Shared;
const MUTE_STORAGE_KEY = "coin-rush-muted";
const LOOKAHEAD_SECONDS = 0.12;
const SCHEDULER_INTERVAL_MS = 25;
const STEPS_PER_BAR = 16;
const TENSION_SCORE = CONFIG.winScore - 5;

const midiToFrequency = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

const CALM_PROGRESSION = [
  { root: 45, chord: [57, 60, 64] },
  { root: 41, chord: [57, 60, 65] },
  { root: 48, chord: [55, 60, 64] },
  { root: 43, chord: [55, 59, 62] },
];

const AGGRESSIVE_PROGRESSION = [
  { root: 45, chord: [57, 60, 64] },
  { root: 45, chord: [57, 60, 64] },
  { root: 41, chord: [57, 60, 65] },
  { root: 40, chord: [56, 59, 64] },
];

const LEVELS = [
  { bpm: 92, kick: [0, 8], snare: [], hats: [0, 4, 8, 12], hatVolume: 0.025, bass: [0, 8], bassVolume: 0.0, arp: [], pad: 0.05, aggressive: false, lead: false },
  { bpm: 104, kick: [0, 8], snare: [], hats: [0, 2, 4, 6, 8, 10, 12, 14], hatVolume: 0.03, bass: [0, 6, 8, 14], bassVolume: 0.11, arp: [], pad: 0.045, aggressive: false, lead: false },
  { bpm: 114, kick: [0, 4, 8, 12], snare: [4, 12], hats: [0, 2, 4, 6, 8, 10, 12, 14], hatVolume: 0.035, bass: [0, 3, 6, 8, 11, 14], bassVolume: 0.12, arp: [0, 2, 4, 6, 8, 10, 12, 14], pad: 0.04, aggressive: false, lead: false },
  { bpm: 128, kick: [0, 4, 7, 8, 12], snare: [4, 12], hats: [...Array(16).keys()], hatVolume: 0.03, bass: [0, 2, 4, 6, 8, 10, 12, 14], bassVolume: 0.13, arp: [...Array(16).keys()], pad: 0.035, aggressive: true, lead: false },
  { bpm: 140, kick: [0, 3, 4, 7, 8, 11, 12, 14], snare: [4, 12, 15], hats: [...Array(16).keys()], hatVolume: 0.035, bass: [...Array(16).keys()], bassVolume: 0.13, arp: [...Array(16).keys()], pad: 0.03, aggressive: true, lead: true },
];

const LOBBY_LEVEL = 0;

const readMuted = () => {
  try {
    return localStorage.getItem(MUTE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

const storeMuted = (muted) => {
  try {
    localStorage.setItem(MUTE_STORAGE_KEY, muted ? "1" : "0");
  } catch {}
};

export const musicLevelFor = (state) => {
  if (state.phase !== "playing") return LOBBY_LEVEL;
  const topRoundWins = Math.max(0, ...state.players.map((player) => player.roundWins));
  const topScore = Math.max(0, ...state.players.map((player) => player.score));
  const matchPoint = topRoundWins >= CONFIG.roundsToWin - 1;
  const base = matchPoint ? 3 : topRoundWins >= Math.ceil((CONFIG.roundsToWin - 1) / 2) ? 2 : 1;
  return Math.min(LEVELS.length - 1, base + (topScore >= TENSION_SCORE ? 1 : 0));
};

export const createAudio = () => {
  let context = null;
  let master = null;
  let sfxBus = null;
  let musicBus = null;
  let noiseBuffer = null;
  let distortion = null;
  let muted = readMuted();
  let musicLevel = LOBBY_LEVEL;
  let pendingLevel = LOBBY_LEVEL;
  let step = 0;
  let nextStepTime = 0;
  let trapTicker = null;

  const buildDistortionCurve = (amount) => {
    const samples = 1024;
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  };

  const setup = () => {
    context = new AudioContext();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.ratio.value = 4;
    master = context.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(compressor).connect(context.destination);
    sfxBus = context.createGain();
    sfxBus.gain.value = 0.9;
    sfxBus.connect(master);
    musicBus = context.createGain();
    musicBus.gain.value = 0.55;
    musicBus.connect(master);
    distortion = context.createWaveShaper();
    distortion.curve = buildDistortionCurve(40);
    distortion.oversample = "2x";
    const distortionLevel = context.createGain();
    distortionLevel.gain.value = 0.5;
    distortion.connect(distortionLevel).connect(musicBus);
    noiseBuffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    nextStepTime = context.currentTime + 0.1;
    setInterval(scheduleMusic, SCHEDULER_INTERVAL_MS);
  };

  const unlock = () => {
    if (!context) setup();
    if (context.state === "suspended") context.resume();
  };

  const ready = () => context && context.state === "running";

  const output = (destination, pan) => {
    if (!pan) return destination;
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(destination);
    return panner;
  };

  const envelope = (gain, start, peak, attack, decay) => {
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
  };

  const tone = ({ frequency, slideTo, type = "sine", start = context.currentTime, attack = 0.005, decay = 0.2, volume = 0.2, pan = 0, destination = sfxBus, detune = 0 }) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.detune.value = detune;
    if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo, start + attack + decay);
    envelope(gain, start, volume, attack, decay);
    oscillator.connect(gain).connect(output(destination, pan));
    oscillator.start(start);
    oscillator.stop(start + attack + decay + 0.05);
  };

  const noise = ({ start = context.currentTime, attack = 0.003, decay = 0.2, volume = 0.2, filter = "bandpass", frequency = 1000, frequencyTo, q = 1, pan = 0, destination = sfxBus }) => {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    const shaping = context.createBiquadFilter();
    shaping.type = filter;
    shaping.frequency.setValueAtTime(frequency, start);
    if (frequencyTo) shaping.frequency.exponentialRampToValueAtTime(frequencyTo, start + attack + decay);
    shaping.Q.value = q;
    const gain = context.createGain();
    envelope(gain, start, volume, attack, decay);
    source.connect(shaping).connect(gain).connect(output(destination, pan));
    source.start(start, Math.random() * 0.5);
    source.stop(start + attack + decay + 0.05);
  };

  const bell = (frequency, start, volume, pan, decay = 0.6) => {
    [1, 2.76, 5.4, 8.93].forEach((ratio, index) => {
      tone({ frequency: frequency * ratio, type: "sine", start, decay: decay / (index + 1), volume: volume / (index + 1.5), pan });
    });
  };

  const melody = (notes, { start = context.currentTime, gap = 0.08, type = "triangle", volume = 0.15, decay = 0.18, pan = 0 } = {}) => {
    notes.forEach((midi, index) => tone({ frequency: midiToFrequency(midi), type, start: start + index * gap, decay, volume, pan }));
  };

  const panFor = (x) => (x === undefined ? 0 : ((x - CONFIG.width / 2) / (CONFIG.width / 2)) * 0.7);
  const loudness = (isMine) => (isMine ? 1 : 0.55);

  const sounds = {
    coin: (event, myId) => {
      const mine = event.playerId === myId;
      const pan = panFor(event.x);
      const now = context.currentTime;
      tone({ frequency: 1318, type: "square", start: now, decay: 0.06, volume: 0.05 * loudness(mine), pan });
      tone({ frequency: 1976, type: "square", start: now + 0.055, decay: 0.16, volume: 0.05 * loudness(mine), pan });
      if (mine) tone({ frequency: 3951, type: "sine", start: now + 0.055, decay: 0.2, volume: 0.03 });
    },
    hit: (event, myId) => {
      const involved = event.attackerId === myId || event.victimId === myId;
      const pan = panFor(event.x);
      const power = Math.min(2, event.strength) * loudness(involved);
      tone({ frequency: 160, slideTo: 40, type: "sine", decay: 0.28, volume: 0.45 * power, pan });
      noise({ filter: "highpass", frequency: 1500, decay: 0.14, volume: 0.25 * power, pan });
      tone({ frequency: 90, slideTo: 60, type: "square", decay: 0.1, volume: 0.08 * power, pan });
    },
    spawnerHit: (event, myId) => {
      const pan = panFor(event.x);
      bell(330, context.currentTime, 0.18 * loudness(event.attackerId === myId), pan, 0.9);
      tone({ frequency: 120, slideTo: 60, decay: 0.2, volume: 0.25, pan });
    },
    spawnerBreak: (event) => {
      const pan = panFor(event.x);
      const now = context.currentTime;
      tone({ frequency: 110, slideTo: 30, decay: 0.7, volume: 0.5, pan });
      noise({ filter: "lowpass", frequency: 6000, frequencyTo: 300, decay: 0.9, volume: 0.35, pan });
      for (let i = 0; i < 9; i++) {
        bell(900 + Math.random() * 2400, now + 0.03 + Math.random() * 0.45, 0.07, pan + (Math.random() - 0.5) * 0.4, 0.35);
      }
      melody([76, 72, 69, 64], { start: now + 0.15, gap: 0.09, type: "square", volume: 0.06, pan });
    },
    spawnerSpawn: (event) => {
      melody([64, 68, 71, 76, 80], { gap: 0.05, type: "sine", volume: 0.08, decay: 0.3, pan: panFor(event.x) });
    },
    wallHit: (event, myId) => {
      const mine = event.playerId === myId;
      const pan = panFor(event.x);
      tone({ frequency: 95, slideTo: 38, decay: 0.3, volume: 0.45 * loudness(mine), pan });
      noise({ filter: "lowpass", frequency: 900, decay: 0.2, volume: 0.25 * loudness(mine), pan });
      if (event.lost) melody([67, 63, 58], { start: context.currentTime + 0.08, gap: 0.09, type: "square", volume: 0.07 * loudness(mine), pan });
    },
    trapDrop: (event) => {
      bell(1200, context.currentTime, 0.05, panFor(event.x), 0.2);
    },
    trapSnap: (event, myId) => {
      const mine = event.playerId === myId;
      const pan = panFor(event.x);
      noise({ filter: "highpass", frequency: 3000, decay: 0.08, volume: 0.35 * loudness(mine), pan });
      tone({ frequency: 220, type: "square", decay: 0.12, volume: 0.12 * loudness(mine), pan });
      bell(620, context.currentTime + 0.02, 0.15 * loudness(mine), pan, 0.5);
    },
    unlockFail: (event, myId) => {
      if (event.playerId !== myId) return;
      tone({ frequency: 110, type: "sawtooth", decay: 0.28, volume: 0.12 });
      tone({ frequency: 116, type: "sawtooth", decay: 0.28, volume: 0.1 });
    },
    unlockSuccess: (event, myId) => {
      const mine = event.playerId === myId;
      melody([72, 76, 79, 84], { gap: 0.06, volume: 0.12 * loudness(mine), pan: panFor(event.x) });
    },
    teleport: (event, myId) => {
      const mine = event.playerId === myId;
      tone({ frequency: 180, slideTo: 1800, type: "sine", decay: 0.35, volume: 0.15 * loudness(mine), pan: panFor(event.fromX) });
      tone({ frequency: 1800, slideTo: 400, type: "triangle", start: context.currentTime + 0.3, decay: 0.25, volume: 0.1 * loudness(mine), pan: panFor(event.toX) });
      if (event.lost) melody([67, 63, 58], { start: context.currentTime + 0.4, gap: 0.09, type: "square", volume: 0.07 * loudness(mine) });
    },
    holeOpen: (event) => {
      tone({ frequency: 300, slideTo: 50, type: "sine", decay: 0.7, volume: 0.15, pan: panFor(event.x) });
      noise({ filter: "lowpass", frequency: 400, decay: 0.6, volume: 0.1, pan: panFor(event.x) });
    },
    holeClose: (event) => {
      tone({ frequency: 60, slideTo: 500, type: "sine", decay: 0.25, volume: 0.1, pan: panFor(event.x) });
    },
    chaosSpawn: (event) => {
      melody([84, 88, 91, 96], { gap: 0.04, type: "sine", volume: 0.05, decay: 0.25, pan: panFor(event.x) });
    },
    chaosPickup: (event, myId) => {
      const pan = panFor(event.x);
      const level = loudness(event.playerId === myId);
      if (event.kind === "swapPosition") {
        tone({ frequency: 400, slideTo: 2400, type: "sawtooth", decay: 0.18, volume: 0.06 * level, pan });
        tone({ frequency: 2400, slideTo: 400, type: "sawtooth", start: context.currentTime + 0.16, decay: 0.18, volume: 0.06 * level, pan });
      } else if (event.kind === "swapCoins") {
        for (let i = 0; i < 8; i++) tone({ frequency: 1318 + i * 120, type: "square", start: context.currentTime + i * 0.035, decay: 0.07, volume: 0.035 * level, pan });
      } else {
        for (let i = 0; i < 4; i++) tone({ frequency: i % 2 ? 660 : 880, type: "square", start: context.currentTime + i * 0.14, decay: 0.12, volume: 0.06 * level, pan });
      }
    },
    roundStart: () => {
      const now = context.currentTime;
      melody([60, 64, 67], { start: now, gap: 0.1, type: "square", volume: 0.07, decay: 0.12 });
      tone({ frequency: midiToFrequency(72), type: "square", start: now + 0.3, decay: 0.5, volume: 0.09 });
      tone({ frequency: midiToFrequency(76), type: "triangle", start: now + 0.3, decay: 0.5, volume: 0.07 });
    },
  };

  const handleEvent = (event, myId) => {
    if (!ready()) return;
    const sound = sounds[event.type];
    if (sound) sound(event, myId);
  };

  const dash = (isMine, x) => {
    if (!ready()) return;
    const pan = panFor(x);
    noise({ filter: "bandpass", frequency: 500, frequencyTo: 3200, q: 2, decay: 0.22, volume: 0.25 * loudness(isMine), pan });
    tone({ frequency: 220, slideTo: 90, type: "sine", decay: 0.18, volume: 0.12 * loudness(isMine), pan });
  };

  const lockStep = () => {
    if (ready()) tone({ frequency: 1046, type: "square", decay: 0.05, volume: 0.05 });
  };

  const uiMove = () => {
    if (ready()) tone({ frequency: 880, type: "triangle", decay: 0.05, volume: 0.06 });
  };

  const uiConfirm = () => {
    if (ready()) melody([76, 83], { gap: 0.06, volume: 0.08, decay: 0.12 });
  };

  const roundEnd = (iWon, matchOver) => {
    if (!ready()) return;
    const now = context.currentTime;
    if (matchOver && iWon) {
      melody([60, 64, 67, 72, 67, 72, 76, 79, 84], { start: now, gap: 0.11, type: "square", volume: 0.08, decay: 0.2 });
      tone({ frequency: midiToFrequency(48), type: "triangle", start: now, decay: 1.4, volume: 0.12 });
    } else if (iWon) {
      melody([67, 72, 76, 79], { start: now, gap: 0.09, type: "square", volume: 0.08, decay: 0.2 });
    } else {
      melody([69, 67, 64, 57], { start: now, gap: 0.14, type: "triangle", volume: 0.08, decay: 0.25 });
    }
  };

  const setTrapped = (trapped) => {
    if (trapped && !trapTicker) {
      trapTicker = setInterval(() => {
        if (ready()) {
          tone({ frequency: 2200, type: "square", decay: 0.02, volume: 0.04 });
          tone({ frequency: 70, type: "sine", decay: 0.12, volume: 0.12 });
        }
      }, 450);
    } else if (!trapped && trapTicker) {
      clearInterval(trapTicker);
      trapTicker = null;
    }
  };

  const setMusicLevel = (level) => {
    pendingLevel = level;
  };

  const kick = (time, volume) => {
    tone({ frequency: 130, slideTo: 42, type: "sine", start: time, decay: 0.28, volume, destination: musicBus });
  };

  const snare = (time, volume) => {
    noise({ start: time, filter: "bandpass", frequency: 1900, q: 0.8, decay: 0.14, volume, destination: musicBus });
    tone({ frequency: 190, type: "triangle", start: time, decay: 0.08, volume: volume * 0.6, destination: musicBus });
  };

  const hat = (time, volume, open) => {
    noise({ start: time, filter: "highpass", frequency: 7500, decay: open ? 0.14 : 0.035, volume, destination: musicBus });
  };

  const bass = (time, midi, length, volume, aggressive) => {
    const oscillator = context.createOscillator();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    oscillator.type = "sawtooth";
    oscillator.frequency.value = midiToFrequency(midi);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(aggressive ? 1400 : 500, time);
    filter.frequency.exponentialRampToValueAtTime(aggressive ? 300 : 180, time + length);
    filter.Q.value = aggressive ? 8 : 2;
    envelope(gain, time, volume, 0.005, length);
    oscillator.connect(filter).connect(gain).connect(aggressive ? distortion : musicBus);
    oscillator.start(time);
    oscillator.stop(time + length + 0.05);
  };

  const pad = (time, chord, length, volume) => {
    for (const midi of chord) {
      for (const detune of [-8, 8]) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "triangle";
        oscillator.frequency.value = midiToFrequency(midi);
        oscillator.detune.value = detune;
        gain.gain.setValueAtTime(0.0001, time);
        gain.gain.linearRampToValueAtTime(volume / chord.length, time + length * 0.3);
        gain.gain.linearRampToValueAtTime(0.0001, time + length);
        oscillator.connect(gain).connect(musicBus);
        oscillator.start(time);
        oscillator.stop(time + length + 0.05);
      }
    }
  };

  const playStep = (time) => {
    const level = LEVELS[musicLevel];
    const stepLength = 60 / level.bpm / 4;
    const barIndex = Math.floor(step / STEPS_PER_BAR);
    const progression = level.aggressive ? AGGRESSIVE_PROGRESSION : CALM_PROGRESSION;
    const { root, chord } = progression[barIndex % progression.length];
    const position = step % STEPS_PER_BAR;
    if (position === 0) pad(time, chord, stepLength * STEPS_PER_BAR, level.pad);
    if (level.kick.includes(position)) kick(time, level.aggressive ? 0.42 : 0.32);
    if (level.snare.includes(position)) snare(time, 0.16);
    if (level.hats.includes(position)) hat(time, level.hatVolume * (position % 4 === 2 ? 1.4 : 1), level.aggressive && position % 8 === 6);
    if (level.bassVolume && level.bass.includes(position)) {
      const octave = level.aggressive && position % 4 === 2 ? 12 : 0;
      bass(time, root + octave, stepLength * (level.aggressive ? 1.6 : 2.5), level.bassVolume, level.aggressive);
    }
    if (level.arp.includes(position)) {
      const note = chord[position % chord.length] + (position % 8 >= 4 ? 12 : 0);
      tone({ frequency: midiToFrequency(note), type: level.aggressive ? "sawtooth" : "square", start: time, decay: stepLength * 0.9, volume: level.aggressive ? 0.025 : 0.02, destination: musicBus });
    }
    if (level.lead && position % 4 === 0) {
      tone({ frequency: midiToFrequency(chord[(barIndex + position / 4) % chord.length] + 12), type: "sawtooth", start: time, decay: stepLength * 2.5, volume: 0.035, destination: musicBus, detune: 6 });
    }
  };

  const scheduleMusic = () => {
    if (!ready()) return;
    if (nextStepTime < context.currentTime - 0.5) nextStepTime = context.currentTime + 0.05;
    while (nextStepTime < context.currentTime + LOOKAHEAD_SECONDS) {
      if (step % STEPS_PER_BAR === 0 && pendingLevel !== musicLevel) musicLevel = pendingLevel;
      playStep(nextStepTime);
      nextStepTime += 60 / LEVELS[musicLevel].bpm / 4;
      step += 1;
    }
  };

  const toggleMute = () => {
    muted = !muted;
    storeMuted(muted);
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.9, context.currentTime, 0.05);
    return muted;
  };

  return { unlock, handleEvent, dash, lockStep, uiMove, uiConfirm, roundEnd, setTrapped, setMusicLevel, toggleMute, isMuted: () => muted };
};
