import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

// --- SETUP FOR ES MODULES ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

// 1. Serve static files (your index.html, css, client-side js)
app.use(express.static(path.join(__dirname, "dist")));

// 2. Initialize Socket.io using the HTTP server
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

// --- YOUR GAME LOGIC START ---
const GRID_SIZE = 20;
const FLEET_SIZES = [5, 4, 4, 3, 3, 3, 2, 2, 2, 2];

let gameState = {
  players: {},
  turn: null,
  apRemaining: 3,
  boards: {},
  opponentMisses: {},
  winner: null
};

// ... [Keep all your helper functions: getShipTiles, isValidPlacement, etc. exactly as they were] ...

function getShipTiles(
  ship,
  overrideX = ship.x,
  overrideY = ship.y,
  overrideVert = ship.isVertical
) {
  let tiles = [];
  for (let i = 0; i < ship.length; i++) {
    tiles.push({
      x: overrideVert ? overrideX : overrideX + i,
      y: overrideVert ? overrideY + i : overrideY
    });
  }
  return tiles;
}

function isValidPlacement(tiles, playerId, ignoreShipId = null) {
  for (let t of tiles) {
    if (t.x < 0 || t.x >= GRID_SIZE || t.y < 0 || t.y >= GRID_SIZE)
      return false;
    if (!gameState.boards[playerId]) continue;
    for (let s of gameState.boards[playerId]) {
      if (s.id === ignoreShipId) continue;
      let sTiles = getShipTiles(s);
      if (sTiles.some(st => st.x === t.x && st.y === t.y)) return false;
    }
  }
  return true;
}

function generateRandomFleet() {
  const fleet = [];
  let shipCounter = 0;
  for (const length of FLEET_SIZES) {
    let placed = false;
    while (!placed) {
      const isVertical = Math.random() < 0.5;
      const x = Math.floor(Math.random() * GRID_SIZE);
      const y = Math.floor(Math.random() * GRID_SIZE);
      const proposedTiles = getShipTiles({ length }, x, y, isVertical);

      const tempStateBoards = [...fleet];
      const oldBoards = gameState.boards;
      gameState.boards = { temp: tempStateBoards };

      if (isValidPlacement(proposedTiles, "temp")) {
        shipCounter++;
        fleet.push({
          id: `ship_${shipCounter}_len${length}`,
          x,
          y,
          length,
          isVertical,
          hits: Array(length).fill(false)
        });
        placed = true;
      }
      gameState.boards = oldBoards;
    }
  }
  return fleet;
}

function clearSplashesUnderShip(playerId, ship) {
  const tiles = getShipTiles(ship);
  gameState.opponentMisses[playerId] = gameState.opponentMisses[
    playerId
  ].filter(miss => {
    return !tiles.some(t => t.x === miss.x && t.y === miss.y);
  });
}

function checkWinCondition() {
  for (let playerId in gameState.boards) {
    const allShipsDestroyed = gameState.boards[playerId].every(ship =>
      ship.hits.every(hit => hit === true)
    );
    if (allShipsDestroyed) {
      gameState.winner = Object.keys(gameState.players).find(
        id => id !== playerId
      );
      io.emit("updateState", gameState);
    }
  }
}

// --- SOCKET LISTENERS ---
io.on("connection", socket => {
  console.log("A player connected:", socket.id);

  if (Object.keys(gameState.players).length >= 2) return;

  gameState.players[socket.id] = true;
  gameState.boards[socket.id] = generateRandomFleet();
  gameState.opponentMisses[socket.id] = [];

  if (Object.keys(gameState.players).length === 2) {
    gameState.turn = Object.keys(gameState.players)[0];
    io.emit("gameStart", gameState);
  }

  function consumeAP(amount) {
    gameState.apRemaining -= amount;
    if (gameState.apRemaining <= 0) {
      gameState.turn = Object.keys(gameState.players).find(
        id => id !== gameState.turn
      );
      gameState.apRemaining = 3;
    }
    checkWinCondition();
    io.emit("updateState", gameState);
  }

  socket.on("shoot", ({ x, y }) => {
    if (
      gameState.turn !== socket.id ||
      gameState.apRemaining < 1 ||
      gameState.winner
    )
      return;
    const enemyId = Object.keys(gameState.players).find(id => id !== socket.id);
    let hitSomething = false;

    for (let ship of gameState.boards[enemyId]) {
      let tiles = getShipTiles(ship);
      let hitIndex = tiles.findIndex(t => t.x === x && t.y === y);
      if (hitIndex !== -1) {
        ship.hits[hitIndex] = true;
        hitSomething = true;
        break;
      }
    }
    if (!hitSomething) {
      const alreadyMissed = gameState.opponentMisses[enemyId].some(
        m => m.x === x && m.y === y
      );
      if (!alreadyMissed) gameState.opponentMisses[enemyId].push({ x, y });
    }
    consumeAP(1);
  });

  socket.on("moveShip", ({ shipId, direction }) => {
    if (
      gameState.turn !== socket.id ||
      gameState.apRemaining < 1 ||
      gameState.winner
    )
      return;
    const ship = gameState.boards[socket.id].find(s => s.id === shipId);
    if (!ship || ship.hits.includes(true)) return;

    let newX = ship.x;
    let newY = ship.y;
    if (ship.isVertical) {
      if (direction === "forward") newY -= 1;
      if (direction === "backward") newY += 1;
    } else {
      if (direction === "forward") newX -= 1;
      if (direction === "backward") newX += 1;
    }

    const proposedTiles = getShipTiles(ship, newX, newY, ship.isVertical);
    if (isValidPlacement(proposedTiles, socket.id, ship.id)) {
      ship.x = newX;
      ship.y = newY;
      clearSplashesUnderShip(socket.id, ship);
      consumeAP(1);
    }
  });

  socket.on("rotateShip", ({ shipId }) => {
    if (
      gameState.turn !== socket.id ||
      gameState.apRemaining < 3 ||
      gameState.winner
    )
      return;
    const ship = gameState.boards[socket.id].find(s => s.id === shipId);
    if (!ship || ship.hits.includes(true)) return;

    const centerIndex = Math.floor(ship.length / 2);
    const pivotX = ship.isVertical ? ship.x : ship.x + centerIndex;
    const pivotY = ship.isVertical ? ship.y + centerIndex : ship.y;
    const newIsVertical = !ship.isVertical;
    const newX = newIsVertical ? pivotX : pivotX - centerIndex;
    const newY = newIsVertical ? pivotY - centerIndex : pivotY;

    const proposedTiles = getShipTiles(ship, newX, newY, newIsVertical);
    if (isValidPlacement(proposedTiles, socket.id, ship.id)) {
      ship.x = newX;
      ship.y = newY;
      ship.isVertical = newIsVertical;
      clearSplashesUnderShip(socket.id, ship);
      consumeAP(3);
    }
  });

  socket.on("disconnect", () => {
    delete gameState.players[socket.id];
    // Reset game if someone leaves
    if (Object.keys(gameState.players).length < 2) {
      gameState.winner = null;
      gameState.turn = null;
    }
  });
});

// --- START THE SERVER ---
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
