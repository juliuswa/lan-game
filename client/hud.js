const { CONFIG, POWER_UPS } = window.Shared;

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const powerUpSummary = (powerUps) =>
  POWER_UPS.filter(({ key }) => powerUps[key] > 0)
    .map(({ key, label }) => `${label} ×${powerUps[key]}`)
    .join(", ");

const renderScoreboard = (list, state) => {
  const ranked = [...state.players].sort((a, b) => b.roundWins - a.roundWins || b.score - a.score);
  list.replaceChildren(
    ...ranked.map((player) => {
      const row = element("li");
      row.style.setProperty("--player-color", player.color);
      const name = element("div", "score-name", player.name);
      const coins = element("div", "score-coins", `${player.score}`);
      const bar = element("div", "score-bar");
      const fill = element("div", "score-fill");
      fill.style.width = `${Math.min(100, (player.score / CONFIG.winScore) * 100)}%`;
      bar.appendChild(fill);
      const rounds = element("div", "score-rounds", "★".repeat(player.roundWins) + "☆".repeat(Math.max(0, CONFIG.roundsToWin - player.roundWins)));
      row.append(name, coins, bar, rounds);
      const summary = powerUpSummary(player.powerUps);
      if (summary) row.appendChild(element("div", "score-powerups", summary));
      return row;
    }),
  );
};

const renderReady = (panel, state, myId) => {
  const me = state.players.find((player) => player.id === myId);
  const readyCount = state.players.filter((player) => player.ready).length;
  panel.append(
    element("h2", null, me && me.ready ? "Waiting for others…" : "Press SPACE when ready"),
    element("p", "muted", `${readyCount} / ${state.players.length} ready`),
  );
  const list = element("ul", "ready-list");
  for (const player of state.players) {
    const row = element("li");
    const name = element("span", "ready-name", player.name);
    name.style.color = player.color;
    row.append(name, element("span", player.ready ? "ready-yes" : "ready-no", player.ready ? "✓ ready" : "… not ready"));
    list.appendChild(row);
  }
  panel.appendChild(list);
};

const renderIntermission = (panel, state, myId, selectedPowerUp) => {
  const me = state.players.find((player) => player.id === myId);
  panel.appendChild(element("h2", null, `${state.roundWinner} wins the round!`));
  if (me && me.pendingPick) {
    panel.appendChild(element("p", null, "You had the fewest coins — pick a power-up"));
    const cards = element("div", "cards");
    POWER_UPS.forEach((powerUp, index) => {
      const card = element("div", index === selectedPowerUp ? "card selected" : "card");
      card.append(element("h3", null, powerUp.label), element("p", null, powerUp.description), element("p", "muted", `owned: ${me.powerUps[powerUp.key]}`));
      cards.appendChild(card);
    });
    panel.append(cards, element("p", "muted", `A/D to choose · Space to confirm · ${state.pickSecondsLeft}s`));
    return;
  }
  const waitingFor = state.players.filter((player) => player.pendingPick).map((player) => player.name);
  panel.appendChild(element("p", null, waitingFor.length ? `Waiting for ${waitingFor.join(", ")} to pick a power-up… ${state.pickSecondsLeft}s` : "Next round starting…"));
};

const renderMatchOver = (panel, state) => {
  panel.append(element("h2", "big", `${state.matchWinner} wins the match!`), element("p", "muted", "New match starting soon…"));
};

const OVERLAYS = { ready: renderReady, intermission: renderIntermission, matchOver: renderMatchOver };

export const createHud = ({ scoreList, overlay }) => {
  let scoreKey = "";
  let overlayKey = "";

  const update = (state, myId, selectedPowerUp) => {
    const nextScoreKey = JSON.stringify(state.players.map(({ id, name, score, roundWins, powerUps }) => [id, name, score, roundWins, powerUps]));
    if (nextScoreKey !== scoreKey) {
      scoreKey = nextScoreKey;
      renderScoreboard(scoreList, state);
    }
    const renderOverlay = OVERLAYS[state.phase];
    const nextOverlayKey = renderOverlay
      ? JSON.stringify([state.phase, state.roundWinner, state.matchWinner, state.pickSecondsLeft, selectedPowerUp, state.players.map(({ id, name, ready, pendingPick, powerUps }) => [id, name, ready, pendingPick, powerUps])])
      : "";
    if (nextOverlayKey === overlayKey) return;
    overlayKey = nextOverlayKey;
    overlay.replaceChildren();
    overlay.hidden = !renderOverlay;
    if (renderOverlay) renderOverlay(overlay, state, myId, selectedPowerUp);
  };

  return { update };
};
