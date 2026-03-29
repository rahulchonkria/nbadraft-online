const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Board Layout (10×10) ─────────────────────────────────────────────
// Each cell is a card code: "2S" = 2♠, "TH" = 10♥, "FR" = free corner
const BOARD_LAYOUT = [
  ['FR','2S','3S','4S','5S','6S','7S','8S','9S','FR'],
  ['6C','5C','4C','3C','2C','AH','KH','QH','TH','TS'],
  ['7C','AS','2D','3D','4D','5D','6D','7D','9H','QS'],
  ['8C','KS','6C','5C','4C','3C','2C','8D','8H','KS'],
  ['9C','QS','7C','6H','5H','4H','AC','9D','7H','AS'],
  ['TC','TS','8C','7H','2H','3H','KC','TD','6H','2D'],
  ['QC','9S','9C','8H','9H','TH','QC','QD','5H','3D'],
  ['KC','8S','TC','QH','KH','AH','AD','KD','4H','4D'],
  ['AC','7S','6S','5S','4S','3S','2S','2H','3H','5D'],
  ['FR','AD','KD','QD','TD','9D','8D','7D','6D','FR'],
];

// ── Helpers ──────────────────────────────────────────────────────────
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['S','H','D','C'];

function buildDeck() {
  const deck = [];
  for (let d = 0; d < 2; d++) {           // two standard decks
    for (const r of RANKS) {
      for (const s of SUITS) {
        deck.push(r + s);
      }
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isTwoEyedJack(card) { return card === 'JD' || card === 'JC'; }
function isOneEyedJack(card)  { return card === 'JH' || card === 'JS'; }

function cardsPerPlayer(totalPlayers) {
  if (totalPlayers <= 2) return 7;
  if (totalPlayers <= 4) return 6;
  if (totalPlayers <= 6) return 5;
  if (totalPlayers <= 8) return 4;
  return 3;
}

function sequencesToWin(numTeams) {
  return numTeams >= 3 ? 1 : 2;
}

// ── Game Class ───────────────────────────────────────────────────────
class Game {
  constructor(roomCode, hostId) {
    this.roomCode = roomCode;
    this.hostId = hostId;
    this.players = [];           // { id, name, teamIndex }
    this.numTeams = 2;
    this.started = false;
    this.board = [];             // 10×10 of { card, chip: null|teamIndex }
    this.deck = [];
    this.discardPile = [];
    this.hands = {};             // playerId -> [card, ...]
    this.currentPlayerIndex = 0;
    this.sequences = [];         // [{cells:[[r,c],...], team: teamIndex}]
    this.sequenceCells = new Set(); // "r,c" strings for cells in completed sequences
    this.winner = null;
    this.teamSequenceCount = {};
    this.lastMove = null;

    // Initialise empty board
    for (let r = 0; r < 10; r++) {
      this.board[r] = [];
      for (let c = 0; c < 10; c++) {
        this.board[r][c] = { card: BOARD_LAYOUT[r][c], chip: null };
      }
    }
  }

  addPlayer(id, name) {
    if (this.started) return { ok: false, error: 'Game already started' };
    if (this.players.length >= 12) return { ok: false, error: 'Game is full' };
    if (this.players.find(p => p.id === id)) return { ok: false, error: 'Already in game' };
    const teamIndex = this.players.length % this.numTeams;
    this.players.push({ id, name, teamIndex });
    return { ok: true };
  }

  removePlayer(id) {
    this.players = this.players.filter(p => p.id !== id);
  }

  setTeams(numTeams) {
    if (this.started) return;
    this.numTeams = numTeams;
    // Reassign teams round-robin
    this.players.forEach((p, i) => { p.teamIndex = i % numTeams; });
  }

  setPlayerTeam(playerId, teamIndex) {
    const p = this.players.find(x => x.id === playerId);
    if (p) p.teamIndex = teamIndex;
  }

  start() {
    if (this.players.length < 2) return { ok: false, error: 'Need at least 2 players' };
    this.started = true;
    this.deck = buildDeck();
    this.discardPile = [];
    const num = cardsPerPlayer(this.players.length);
    this.hands = {};
    for (const p of this.players) {
      this.hands[p.id] = this.deck.splice(0, num);
    }
    this.currentPlayerIndex = 0;
    this.teamSequenceCount = {};
    for (let t = 0; t < this.numTeams; t++) this.teamSequenceCount[t] = 0;
    return { ok: true };
  }

  currentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  // Find board positions for a card
  findPositions(card) {
    const positions = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        if (BOARD_LAYOUT[r][c] === card) positions.push([r, c]);
      }
    }
    return positions;
  }

  isDeadCard(card, playerId) {
    if (card.startsWith('J')) return false; // Jacks are never dead
    const positions = this.findPositions(card);
    return positions.every(([r, c]) => this.board[r][c].chip !== null);
  }

  // Main play action
  playCard(playerId, cardIndex, row, col) {
    if (this.winner) return { ok: false, error: 'Game is over' };
    const cp = this.currentPlayer();
    if (cp.id !== playerId) return { ok: false, error: 'Not your turn' };
    const hand = this.hands[playerId];
    if (cardIndex < 0 || cardIndex >= hand.length) return { ok: false, error: 'Invalid card' };
    const card = hand[cardIndex];

    if (isTwoEyedJack(card)) {
      // Wild: place chip on any empty non-free space
      if (row < 0 || row > 9 || col < 0 || col > 9) return { ok: false, error: 'Invalid position' };
      if (BOARD_LAYOUT[row][col] === 'FR') return { ok: false, error: 'Cannot place on free corner' };
      if (this.board[row][col].chip !== null) return { ok: false, error: 'Space already occupied' };
      this.board[row][col].chip = cp.teamIndex;
    } else if (isOneEyedJack(card)) {
      // Remove opponent chip
      if (row < 0 || row > 9 || col < 0 || col > 9) return { ok: false, error: 'Invalid position' };
      if (BOARD_LAYOUT[row][col] === 'FR') return { ok: false, error: 'Cannot remove from free corner' };
      const cell = this.board[row][col];
      if (cell.chip === null) return { ok: false, error: 'No chip to remove' };
      if (cell.chip === cp.teamIndex) return { ok: false, error: 'Cannot remove your own chip' };
      if (this.sequenceCells.has(`${row},${col}`)) return { ok: false, error: 'Cannot remove chip from completed sequence' };
      this.board[row][col].chip = null;
    } else {
      // Normal card: place on matching board space
      if (row < 0 || row > 9 || col < 0 || col > 9) return { ok: false, error: 'Invalid position' };
      if (BOARD_LAYOUT[row][col] !== card) return { ok: false, error: 'Card does not match space' };
      if (this.board[row][col].chip !== null) return { ok: false, error: 'Space already occupied' };
      this.board[row][col].chip = cp.teamIndex;
    }

    // Remove card from hand
    hand.splice(cardIndex, 1);
    // Draw a new card
    if (this.deck.length > 0) {
      hand.push(this.deck.pop());
    } else if (this.discardPile.length > 0) {
      this.deck = shuffle(this.discardPile);
      this.discardPile = [];
      hand.push(this.deck.pop());
    }
    this.discardPile.push(card);

    this.lastMove = { player: cp.name, team: cp.teamIndex, card, row, col, type: isOneEyedJack(card) ? 'remove' : 'place' };

    // Check for new sequences
    if (!isOneEyedJack(card)) {
      this.checkNewSequences(cp.teamIndex);
    }

    // Check win
    const needed = sequencesToWin(this.numTeams);
    for (let t = 0; t < this.numTeams; t++) {
      if (this.teamSequenceCount[t] >= needed) {
        this.winner = t;
        return { ok: true, winner: t };
      }
    }

    // Next turn
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    return { ok: true };
  }

  // Discard a dead card and draw a replacement
  discardDeadCard(playerId, cardIndex) {
    if (this.winner) return { ok: false, error: 'Game is over' };
    const cp = this.currentPlayer();
    if (cp.id !== playerId) return { ok: false, error: 'Not your turn' };
    const hand = this.hands[playerId];
    if (cardIndex < 0 || cardIndex >= hand.length) return { ok: false, error: 'Invalid card' };
    const card = hand[cardIndex];
    if (!this.isDeadCard(card, playerId)) return { ok: false, error: 'Card is not dead' };

    hand.splice(cardIndex, 1);
    this.discardPile.push(card);
    if (this.deck.length > 0) {
      hand.push(this.deck.pop());
    } else if (this.discardPile.length > 0) {
      this.deck = shuffle(this.discardPile);
      this.discardPile = [];
      hand.push(this.deck.pop());
    }

    return { ok: true, drewNew: true };
  }

  checkNewSequences(teamIndex) {
    const directions = [[0,1],[1,0],[1,1],[1,-1]]; // horiz, vert, diag-down-right, diag-down-left

    for (const [dr, dc] of directions) {
      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 10; c++) {
          // Check if a 5-in-a-row starting at (r,c) in direction (dr,dc) exists
          const endR = r + 4 * dr;
          const endC = c + 4 * dc;
          if (endR < 0 || endR > 9 || endC < 0 || endC > 9) continue;

          const cells = [];
          let valid = true;
          for (let i = 0; i < 5; i++) {
            const cr = r + i * dr;
            const cc = c + i * dc;
            const cell = this.board[cr][cc];
            const isFree = BOARD_LAYOUT[cr][cc] === 'FR';
            if (isFree || cell.chip === teamIndex) {
              cells.push([cr, cc]);
            } else {
              valid = false;
              break;
            }
          }

          if (!valid) continue;

          // Check this isn't already a recorded sequence
          const cellKey = cells.map(([cr,cc]) => `${cr},${cc}`).sort().join('|');
          const alreadyExists = this.sequences.some(s => {
            const sk = s.cells.map(([cr,cc]) => `${cr},${cc}`).sort().join('|');
            return sk === cellKey;
          });
          if (alreadyExists) continue;

          // Check that at least one cell is NOT part of a previously completed sequence
          // (you can share one cell with a previous sequence but not all)
          const nonSequenceCells = cells.filter(([cr,cc]) => !this.sequenceCells.has(`${cr},${cc}`));
          // A new sequence must have at least one cell that isn't in an existing sequence
          // Actually the rule is: two sequences can share at most one cell
          const sharedCount = cells.filter(([cr,cc]) => this.sequenceCells.has(`${cr},${cc}`)).length;
          if (sharedCount > 1) continue; // Can share at most 1 cell with existing sequences

          // New sequence found!
          this.sequences.push({ cells, team: teamIndex });
          for (const [cr, cc] of cells) {
            this.sequenceCells.add(`${cr},${cc}`);
          }
          this.teamSequenceCount[teamIndex] = (this.teamSequenceCount[teamIndex] || 0) + 1;
        }
      }
    }
  }

  getState(forPlayerId) {
    return {
      roomCode: this.roomCode,
      started: this.started,
      board: this.board,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        teamIndex: p.teamIndex,
        cardCount: this.hands[p.id] ? this.hands[p.id].length : 0,
        isCurrentTurn: this.started && this.players[this.currentPlayerIndex]?.id === p.id,
      })),
      hand: this.hands[forPlayerId] || [],
      currentPlayerIndex: this.currentPlayerIndex,
      currentPlayerId: this.started ? this.players[this.currentPlayerIndex]?.id : null,
      sequences: this.sequences,
      sequenceCells: [...this.sequenceCells],
      winner: this.winner,
      numTeams: this.numTeams,
      teamSequenceCount: this.teamSequenceCount,
      deckCount: this.deck.length,
      hostId: this.hostId,
      lastMove: this.lastMove,
      neededToWin: sequencesToWin(this.numTeams),
    };
  }
}

// ── Room Management ──────────────────────────────────────────────────
const games = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Socket.IO ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName = null;

  socket.on('create-game', ({ name }, cb) => {
    let code;
    do { code = generateRoomCode(); } while (games[code]);
    const game = new Game(code, socket.id);
    game.addPlayer(socket.id, name);
    games[code] = game;
    currentRoom = code;
    playerName = name;
    socket.join(code);
    cb({ ok: true, roomCode: code });
    io.to(code).emit('game-state', game.getState(socket.id));
  });

  socket.on('join-game', ({ name, roomCode }, cb) => {
    const code = roomCode.toUpperCase().trim();
    const game = games[code];
    if (!game) return cb({ ok: false, error: 'Room not found' });
    const result = game.addPlayer(socket.id, name);
    if (!result.ok) return cb(result);
    currentRoom = code;
    playerName = name;
    socket.join(code);
    cb({ ok: true, roomCode: code });
    // Send state to all players
    for (const p of game.players) {
      io.to(p.id).emit('game-state', game.getState(p.id));
    }
  });

  socket.on('set-teams', ({ numTeams }) => {
    const game = games[currentRoom];
    if (!game || socket.id !== game.hostId) return;
    game.setTeams(numTeams);
    for (const p of game.players) {
      io.to(p.id).emit('game-state', game.getState(p.id));
    }
  });

  socket.on('set-player-team', ({ playerId, teamIndex }) => {
    const game = games[currentRoom];
    if (!game || socket.id !== game.hostId) return;
    game.setPlayerTeam(playerId, teamIndex);
    for (const p of game.players) {
      io.to(p.id).emit('game-state', game.getState(p.id));
    }
  });

  socket.on('start-game', (_, cb) => {
    const game = games[currentRoom];
    if (!game) return cb({ ok: false, error: 'No game' });
    if (socket.id !== game.hostId) return cb({ ok: false, error: 'Only host can start' });
    const result = game.start();
    if (!result.ok) return cb(result);
    cb({ ok: true });
    for (const p of game.players) {
      io.to(p.id).emit('game-state', game.getState(p.id));
    }
  });

  socket.on('play-card', ({ cardIndex, row, col }, cb) => {
    const game = games[currentRoom];
    if (!game) return cb({ ok: false, error: 'No game' });
    const result = game.playCard(socket.id, cardIndex, row, col);
    cb(result);
    for (const p of game.players) {
      io.to(p.id).emit('game-state', game.getState(p.id));
    }
  });

  socket.on('discard-dead', ({ cardIndex }, cb) => {
    const game = games[currentRoom];
    if (!game) return cb({ ok: false, error: 'No game' });
    const result = game.discardDeadCard(socket.id, cardIndex);
    cb(result);
    for (const p of game.players) {
      io.to(p.id).emit('game-state', game.getState(p.id));
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && games[currentRoom]) {
      const game = games[currentRoom];
      game.removePlayer(socket.id);
      if (game.players.length === 0) {
        delete games[currentRoom];
      } else {
        // Transfer host if needed
        if (game.hostId === socket.id) {
          game.hostId = game.players[0].id;
        }
        for (const p of game.players) {
          io.to(p.id).emit('game-state', game.getState(p.id));
          io.to(p.id).emit('player-left', { name: playerName });
        }
      }
    }
  });
});

// ── Start ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sequence server running on http://localhost:${PORT}`);
});
