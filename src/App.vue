<script setup>
import { ref, onMounted, computed } from "vue";
import { io } from "socket.io-client";

const socket = io();

const myId = ref("");
const gameState = ref(null);
const selectedShip = ref(null);

const temporaryMisses = ref([]);
let previousEnemyMissesCount = 0;

const localTurnCount = ref(0);
const lastTurnId = ref("");
const myMissesData = ref(new Map());
const enemyMissesData = ref(new Map());

onMounted(() => {
  socket.on("connect", () => (myId.value = socket.id));

  socket.on("gameStart", state => {
    gameState.value = state;
    localTurnCount.value = 0;
    lastTurnId.value = state.turn;
    myMissesData.value.clear();
    enemyMissesData.value.clear();

    const currentEnemyMisses = state.opponentMisses[enemyId.value] || [];
    previousEnemyMissesCount = currentEnemyMisses.length;
  });

  socket.on("updateState", state => {
    gameState.value = state;
    if (state.turn !== myId.value) selectedShip.value = null;

    if (lastTurnId.value !== state.turn) {
      localTurnCount.value++;
      lastTurnId.value = state.turn;
    }

    // Enemy misses on my board (Red Decay)
    const currentMyMisses = state.opponentMisses[myId.value] || [];
    currentMyMisses.forEach(m => {
      const key = `${m.x},${m.y}`;
      if (!myMissesData.value.has(key)) {
        myMissesData.value.set(key, localTurnCount.value);
      }
    });

    // My misses on enemy board (Yellow Decay)
    const currentEnemyMisses = state.opponentMisses[enemyId.value] || [];

    if (currentEnemyMisses.length > previousEnemyMissesCount) {
      const newMiss = currentEnemyMisses[currentEnemyMisses.length - 1];
      const tempId = Date.now();
      temporaryMisses.value.push({ ...newMiss, id: tempId });
      setTimeout(() => {
        temporaryMisses.value = temporaryMisses.value.filter(
          m => m.id !== tempId
        );
      }, 2000);
    }
    previousEnemyMissesCount = currentEnemyMisses.length;

    currentEnemyMisses.forEach(m => {
      const key = `${m.x},${m.y}`;
      if (!enemyMissesData.value.has(key)) {
        enemyMissesData.value.set(key, localTurnCount.value);
      }
    });
  });
});

const enemyId = computed(() => {
  if (!gameState.value) return null;
  return Object.keys(gameState.value.players).find(id => id !== myId.value);
});

const isMyTurn = computed(() => gameState.value?.turn === myId.value);
const winner = computed(() => gameState.value?.winner);
const myShips = computed(() => gameState.value?.boards[myId.value] || []);
const enemyShips = computed(() => gameState.value?.boards[enemyId.value] || []);

const myBoardMisses = computed(
  () => gameState.value?.opponentMisses[myId.value] || []
);
const enemyBoardMisses = computed(
  () => gameState.value?.opponentMisses[enemyId.value] || []
);

function shoot(x, y) {
  if (isMyTurn.value) socket.emit("shoot", { x, y });
}

function move(direction) {
  if (selectedShip.value)
    socket.emit("moveShip", { shipId: selectedShip.value.id, direction });
}

function rotate() {
  if (selectedShip.value)
    socket.emit("rotateShip", { shipId: selectedShip.value.id });
}

function getMissOpacity(x, y, isMyBoard) {
  const key = `${x},${y}`;
  const map = isMyBoard ? myMissesData.value : enemyMissesData.value;
  if (!map.has(key)) return 0;

  const turnCreated = map.get(key);
  const age = localTurnCount.value - turnCreated;

  if (age >= 10) return 0;
  return Math.max(0, 0.7 - age * 0.07);
}
</script>

<template>
  <div v-if="gameState && enemyId" class="game-wrapper">
    <div class="hud wood-panel">
      <div class="status-panel">
        <h2 :class="{ 'turn-active': isMyTurn, 'turn-waiting': !isMyTurn }">
          {{ isMyTurn ? "YOUR ORDERS, CAPTAIN" : "WAITING FOR ENEMY MOVES..." }}
        </h2>
        <div class="ap-badge">AP: {{ gameState.apRemaining }}</div>
      </div>

      <div class="action-panel">
        <div
          v-if="selectedShip && isMyTurn && !selectedShip.hits.includes(true)"
          class="controls"
        >
          <button class="wood-btn" @click="move('forward')">
            MOVE FWD (1)
          </button>
          <button class="wood-btn" @click="move('backward')">
            MOVE BCK (1)
          </button>
          <button class="wood-btn" @click="rotate()">ROTATE (3)</button>
        </div>
        <div v-else-if="selectedShip?.hits.includes(true)" class="msg-error">
          SHIP DAMAGED! REPAIRS NEEDED.
        </div>
        <div v-else-if="isMyTurn" class="msg-hint">
          Select an allied ship to command, or click enemy waters to fire.
        </div>
      </div>
    </div>

    <div v-if="winner" class="end-screen wood-panel">
      <h1>{{ winner === myId ? "VICTORY!" : "DEFEAT!" }}</h1>
      <p>The battle has concluded.</p>
    </div>

    <div v-else class="boards-container">
      <div class="board-wrapper">
        <h3 class="board-title">ALLIED FLEET</h3>
        <div class="board wood-frame">
          <div v-for="y in 20" :key="'mybg' + y" class="row">
            <div v-for="x in 20" :key="'mybg' + x" class="cell water"></div>
          </div>

          <div
            v-for="(miss, i) in myBoardMisses"
            :key="'mymiss' + i"
            class="marker"
            :style="{
              left: `calc(var(--cell-size) * ${miss.x})`,
              top: `calc(var(--cell-size) * ${miss.y})`,
              backgroundColor: `rgba(255, 0, 0, ${getMissOpacity(
                miss.x,
                miss.y,
                true
              )})`
            }"
          ></div>

          <div
            v-for="ship in myShips"
            :key="ship.id"
            class="ship-container"
            :class="{
              vertical: ship.isVertical,
              selected: selectedShip?.id === ship.id
            }"
            :style="{
              left: `calc(var(--cell-size) * ${ship.x})`,
              top: `calc(var(--cell-size) * ${ship.y})`
            }"
            @click="if (isMyTurn) selectedShip = ship;"
          >
            <div
              v-for="(hit, index) in ship.hits"
              :key="'segment' + index"
              class="ship-segment"
            >
              <img v-if="index === 0" src="/front.png" />
              <img v-else-if="index === ship.length - 1" src="/back.png" />
              <img v-else src="/middle.png" />
              <img v-if="hit" src="/fire.gif" class="overlay" />
            </div>
          </div>
        </div>
      </div>

      <div class="board-wrapper">
        <h3 class="board-title">ENEMY WATERS</h3>
        <div class="board wood-frame">
          <div v-for="y in 20" :key="'enbg' + y" class="row">
            <div
              v-for="x in 20"
              :key="'enbg' + x"
              class="cell water clickable"
              @click="shoot(x - 1, y - 1)"
            ></div>
          </div>

          <div
            v-for="(miss, i) in enemyBoardMisses"
            :key="'enmisscolor' + i"
            class="marker"
            :style="{
              left: `calc(var(--cell-size) * ${miss.x})`,
              top: `calc(var(--cell-size) * ${miss.y})`,
              backgroundColor: `rgba(255, 215, 0, ${getMissOpacity(
                miss.x,
                miss.y,
                false
              )})`
            }"
          ></div>

          <div
            v-for="miss in temporaryMisses"
            :key="'entempmiss' + miss.id"
            class="marker splash-gif"
            :style="{
              left: `calc(var(--cell-size) * ${miss.x})`,
              top: `calc(var(--cell-size) * ${miss.y})`
            }"
          >
            <img src="/splash.gif" />
          </div>

          <div
            v-for="ship in enemyShips"
            :key="'enship' + ship.id"
            class="ship-container enemy-ship"
            :class="{ vertical: ship.isVertical }"
            :style="{
              left: `calc(var(--cell-size) * ${ship.x})`,
              top: `calc(var(--cell-size) * ${ship.y})`
            }"
          >
            <div
              v-for="(hit, index) in ship.hits"
              :key="'enship-segment' + index"
              class="ship-segment"
            >
              <template v-if="hit">
                <img v-if="index === 0" src="/front.png" />
                <img v-else-if="index === ship.length - 1" src="/back.png" />
                <img v-else src="/middle.png" />
                <img src="/fire.gif" class="overlay" />
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="loading-screen wood-panel">
    <h2 class="blink">WAITING FOR RADAR CONTACT...</h2>
  </div>
</template>

<style scoped>
@import url("https://fonts.googleapis.com/css2?family=VT323&display=swap");

/* =========================================
   SCALABLE VARIABLES (Fixes Overflow)
   ========================================= */
.game-wrapper {
  /* MOBILE FIRST: Fits standard phones */
  --cell-size: 17px;

  font-family: "VT323", monospace;
  background: #110d0a;
  color: #eaddcf;
  min-height: 100vh;
  padding: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  box-sizing: border-box;

  /* Prevent blinking cursor & text highlighting on spam-clicking */
  user-select: none;
  -webkit-user-select: none;
  caret-color: transparent;
}

/* Tablets and small laptops */
@media (min-width: 768px) {
  .game-wrapper {
    --cell-size: 22px;
    padding: 20px;
  }
}

/* Large monitors */
@media (min-width: 1400px) {
  .game-wrapper {
    --cell-size: 28px;
  }
}

/* =========================================
   WOOD THEMES & CONTAINERS
   ========================================= */
.wood-panel {
  background: linear-gradient(135deg, #4e3424, #2d1d12);
  border: 4px solid #1a100a;
  box-shadow: inset 0 0 0 2px #75523a, 4px 4px 10px rgba(0, 0, 0, 0.5);
  border-radius: 6px;
}

.hud {
  width: 100%;
  max-width: 1000px;
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 20px;
  padding: 10px 15px;
}

.status-panel {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  border-bottom: 2px dashed #75523a;
  padding-bottom: 8px;
  margin-bottom: 8px;
}

.status-panel h2 {
  font-size: 1.5rem; /* Adjusted for mobile */
  margin: 0;
  letter-spacing: 1px;
}
@media (min-width: 768px) {
  .status-panel h2 {
    font-size: 1.8rem;
  }
}

.turn-active {
  color: #ffd54f;
  text-shadow: 1px 1px #000;
}
.turn-waiting {
  color: #8d7b68;
}

.ap-badge {
  background: #1a100a;
  color: #ffb300;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 1.2rem;
  border: 1px solid #75523a;
}
@media (min-width: 768px) {
  .ap-badge {
    padding: 4px 12px;
    font-size: 1.5rem;
  }
}

.action-panel {
  min-height: 40px; /* Allows wrapping on phones without jumping */
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
}

.controls {
  display: flex;
  flex-wrap: wrap; /* Wraps buttons nicely on small screens */
  justify-content: center;
  gap: 8px;
}

.wood-btn {
  font-family: "VT323", monospace;
  font-size: 1.1rem;
  padding: 6px 10px;
  cursor: pointer;
  background: #5a3d2b;
  color: #f0e6d2;
  border: 2px solid #855e42;
  border-bottom-color: #2b1d14;
  border-right-color: #2b1d14;
  border-radius: 3px;
  transition: all 0.1s;
}
.wood-btn:focus {
  outline: none;
}
.wood-btn:hover {
  background: #6b4833;
}
.wood-btn:active {
  border-color: #2b1d14;
  border-bottom-color: #855e42;
  border-right-color: #855e42;
}

.msg-hint {
  color: #bcaaa4;
  font-size: 1.2rem;
  text-align: center;
}
.msg-error {
  color: #e57373;
  font-size: 1.2rem;
  font-weight: bold;
  text-align: center;
}

/* =========================================
   BOARDS
   ========================================= */
.boards-container {
  display: flex;
  flex-wrap: wrap; /* Board will wrap on small screens, preventing horizontal overflow */
  justify-content: center;
  gap: 20px;
}
@media (min-width: 768px) {
  .boards-container {
    gap: 30px;
  }
}

.board-title {
  text-align: center;
  font-size: 1.5rem;
  color: #d7ccc8;
  margin: 0 0 8px 0;
  text-shadow: 1px 1px #000;
}

.wood-frame {
  outline: 4px solid #4e3424;
  box-shadow: 0 0 0 6px #2d1d12, 5px 5px 15px rgba(0, 0, 0, 0.8);
}
@media (min-width: 768px) {
  .wood-frame {
    outline: 6px solid #4e3424;
    box-shadow: 0 0 0 10px #2d1d12, 5px 5px 15px rgba(0, 0, 0, 0.8);
  }
}

.board {
  position: relative;
  /* Scalable Width and Height based on variable */
  width: calc(var(--cell-size) * 20);
  height: calc(var(--cell-size) * 20);
  background: #001a33;
}

.row {
  display: flex;
}
.cell {
  width: var(--cell-size);
  height: var(--cell-size);
  border: 1px solid rgba(255, 255, 255, 0.05);
  box-sizing: border-box;
}

.water {
  background-image: url("/water.png");
  background-size: cover;
}
.clickable {
  cursor: crosshair;
}
.clickable:focus {
  outline: none;
}
.clickable:hover {
  background-color: rgba(255, 215, 0, 0.2);
}

/* =========================================
   SHIPS & MARKERS
   ========================================= */
img,
.water,
.splash-gif,
.cell {
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}

.ship-container {
  position: absolute;
  display: flex;
  transition: top 0.3s, left 0.3s;
}
.ship-container.vertical {
  flex-direction: column;
}

.ship-container.selected {
  outline: 2px dashed #ffd54f; /* Yellow selection */
  outline-offset: 1px;
  z-index: 10;
}
.enemy-ship {
  pointer-events: none;
}

.ship-segment {
  width: var(--cell-size);
  height: var(--cell-size);
  position: relative;
}
.ship-segment img {
  width: 100%;
  height: 100%;
  display: block;
}
.ship-segment img:not(.overlay) {
  transform: rotate(270deg);
}
.ship-container.vertical .ship-segment img:not(.overlay) {
  transform: rotate(-0deg);
}

.overlay {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 5;
  pointer-events: none;
}

/* Dynamic marker blocks */
.marker {
  position: absolute;
  width: var(--cell-size);
  height: var(--cell-size);
  pointer-events: none;
  z-index: 4;
  transition: background-color 0.5s ease;
}

.splash-gif img {
  width: 100%;
  height: 100%;
  z-index: 6;
}

/* =========================================
   SCREENS
   ========================================= */
.end-screen {
  text-align: center;
  padding: 40px;
  margin-top: 40px;
  font-size: 1.5rem;
  color: #ffd54f;
}
.end-screen h1 {
  font-size: 3rem;
  margin: 0 0 10px 0;
}

.loading-screen {
  padding: 40px;
  margin-top: 100px;
  color: #ffd54f;
}
.blink {
  animation: blinker 1.5s linear infinite;
}
@keyframes blinker {
  50% {
    opacity: 0;
  }
}
</style>
