import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

// --- SETUP FOR ES MODULES ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AP_TURN_COUNT = 5;
const app = express();
const httpServer = createServer(app);

// 1. Serve static files (your index.html, css, client-side js)
app.use(express.static(path.join(__dirname, "dist")));

// 2. Initialize Socket.io using the HTTP server
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

// --- GAME CONFIGURATION ---
const GRID_SIZE = 20;
const FLEET_SIZES = [10, 7, 6, 6, 5, 4, 4, 3, 3, 3];

// Store multiple active games by their Room ID
const games = {};

// --- HELPER FUNCTIONS ---

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

// Updated to accept the specific 'game' object instead of a global state
function isValidPlacement(tiles, playerId, ignoreShipId = null, game) {
  for (let t of tiles) {
    if (t.x < 0 || t.x >= GRID_SIZE || t.y < 0 || t.y >= GRID_SIZE)
      return false;
    if (!game.boards[playerId]) continue;

    for (let s of game.boards[playerId]) {
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

      // Create a temporary mock game object to check validation without polluting real data
      const mockGame = { boards: { temp: fleet } };

      if (isValidPlacement(proposedTiles, "temp", null, mockGame)) {
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
    }
  }
  return fleet;
}

function clearSplashesUnderShip(game, playerId, ship) {
  const tiles = getShipTiles(ship);
  game.opponentMisses[playerId] = game.opponentMisses[playerId].filter(miss => {
    return !tiles.some(t => t.x === miss.x && t.y === miss.y);
  });
}

function checkWinCondition(roomId) {
  const game = games[roomId];
  if (!game) return;

  for (let playerId in game.boards) {
    const allShipsDestroyed = game.boards[playerId].every(ship =>
      ship.hits.every(hit => hit === true)
    );
    if (allShipsDestroyed) {
      game.winner = Object.keys(game.players).find(id => id !== playerId);
      io.to(roomId).emit("updateState", game);
    }
  }
}

// --- SOCKET LISTENERS ---
io.on("connection", socket => {
  console.log("A player connected:", socket.id);

  function consumeAP(roomId, amount) {
    const game = games[roomId];
    game.apRemaining -= amount;
    if (game.apRemaining <= 0) {
      game.turn = Object.keys(game.players).find(id => id !== game.turn);
      game.apRemaining = AP_TURN_COUNT;
    }
    checkWinCondition(roomId);
    io.to(roomId).emit("updateState", game);
  }

  // --- LOBBY SYSTEM ---

  socket.on("createGame", () => {
    // Generate a random 4-character room code
    const roomId = Math.random()
      .toString(36)
      .substring(2, 6)
      .toUpperCase();

    games[roomId] = {
      players: { [socket.id]: true },
      turn: null,
      apRemaining: AP_TURN_COUNT,
      boards: { [socket.id]: generateRandomFleet() },
      opponentMisses: { [socket.id]: [] },
      winner: null
    };

    socket.roomId = roomId;
    socket.join(roomId);
    socket.emit("roomCreated", roomId);
  });

  socket.on("joinGame", roomId => {
    roomId = roomId.toUpperCase();
    const game = games[roomId];

    if (!game) return socket.emit("errorMsg", "Room not found.");
    if (Object.keys(game.players).length >= 2)
      return socket.emit("errorMsg", "Room is full.");

    game.players[socket.id] = true;
    game.boards[socket.id] = generateRandomFleet();
    game.opponentMisses[socket.id] = [];

    socket.roomId = roomId;
    socket.join(roomId);

    // Start game if 2 players have joined
    if (Object.keys(game.players).length === 2) {
      game.turn = Object.keys(game.players)[0];
      io.to(roomId).emit("gameStart", game);
    }
  });

  // --- GAMEPLAY ACTIONS ---

  socket.on("shoot", ({ x, y }) => {
    const roomId = socket.roomId;
    const game = games[roomId];

    if (!game || game.turn !== socket.id || game.apRemaining < 1 || game.winner)
      return;

    // Validate map boundaries (fixes the edge-click bug)
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      x < 0 ||
      x >= GRID_SIZE ||
      y < 0 ||
      y >= GRID_SIZE
    )
      return;

    const enemyId = Object.keys(game.players).find(id => id !== socket.id);

    // Prevent AP drain on already missed spots
    const alreadyMissed = game.opponentMisses[enemyId].some(
      m => m.x === x && m.y === y
    );
    if (alreadyMissed) return;

    let hitSomething = false;
    let alreadyHit = false;

    for (let ship of game.boards[enemyId]) {
      let tiles = getShipTiles(ship);
      let hitIndex = tiles.findIndex(t => t.x === x && t.y === y);

      if (hitIndex !== -1) {
        if (ship.hits[hitIndex] === true) {
          alreadyHit = true; // Prevent AP drain on burning ship segments
        } else {
          ship.hits[hitIndex] = true;
          hitSomething = true;
        }
        break;
      }
    }

    if (alreadyHit) return;

    if (!hitSomething) {
      game.opponentMisses[enemyId].push({ x, y });
    }

    consumeAP(roomId, 1);
  });

  socket.on("moveShip", ({ shipId, direction }) => {
    const roomId = socket.roomId;
    const game = games[roomId];

    if (!game || game.turn !== socket.id || game.apRemaining < 1 || game.winner)
      return;

    const ship = game.boards[socket.id].find(s => s.id === shipId);
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
    if (isValidPlacement(proposedTiles, socket.id, ship.id, game)) {
      ship.x = newX;
      ship.y = newY;
      clearSplashesUnderShip(game, socket.id, ship);
      consumeAP(roomId, 1);
    }
  });

  socket.on("rotateShip", ({ shipId }) => {
    const roomId = socket.roomId;
    const game = games[roomId];

    if (!game || game.turn !== socket.id || game.apRemaining < 3 || game.winner)
      return;

    const ship = game.boards[socket.id].find(s => s.id === shipId);
    if (!ship || ship.hits.includes(true)) return;

    const centerIndex = Math.floor(ship.length / 2);
    const pivotX = ship.isVertical ? ship.x : ship.x + centerIndex;
    const pivotY = ship.isVertical ? ship.y + centerIndex : ship.y;
    const newIsVertical = !ship.isVertical;
    const newX = newIsVertical ? pivotX : pivotX - centerIndex;
    const newY = newIsVertical ? pivotY - centerIndex : pivotY;

    const proposedTiles = getShipTiles(ship, newX, newY, newIsVertical);
    if (isValidPlacement(proposedTiles, socket.id, ship.id, game)) {
      ship.x = newX;
      ship.y = newY;
      ship.isVertical = newIsVertical;
      clearSplashesUnderShip(game, socket.id, ship);
      consumeAP(roomId, 3);
    }
  });

  // --- DISCONNECT HANDLING ---
  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    const roomId = socket.roomId;

    if (roomId && games[roomId]) {
      // Notify the remaining player that they won by default due to disconnect
      io.to(roomId).emit("enemyDisconnected");
      delete games[roomId]; // Clean up the game from memory
    }
  });
});

// --- START THE SERVER ---
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
