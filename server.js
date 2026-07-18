// NBA All-Time Draft — realtime multiplayer server
// Node.js + ws. Serves the static client and runs game rooms over WebSocket.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const PLAYERS = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'players.json'), 'utf8'));
const PLAYER_BY_ID = new Map(PLAYERS.map(p => [p.id, p]));

// ---------- persistence ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOM_TTL_MS = 1000 * 60 * 60 * 48; // rooms untouched for 48h are pruned
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
let SAVE_DIRTY = false;
const markDirty = () => { SAVE_DIRTY = true; };

// ---------- static file server ----------
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const file = path.join(PUBLIC, path.normalize(url).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- game state ----------
/** rooms: code -> room */
const rooms = new Map();
const genCode = () => {
  let c;
  do { c = Array.from({length:4}, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join(''); }
  while (rooms.has(c));
  return c;
};
const uid = () => Math.random().toString(36).slice(2, 10);

function newRoom(code) {
  return {
    code,
    lastActivity: Date.now(),
    phase: 'lobby',              // lobby | draft | voting_setup | voting | results
    hostId: null,
    players: [],                 // {id, token, name, teamName, connected, ws}
    settings: { rosterSize: 12, pickSeconds: 0 },
    order: [],                   // array of player ids (draft order)
    picks: [],                   // {pickNo, round, teamId, playerId}
    drafted: new Set(),          // player.id already taken
    rosters: {},                 // teamId -> [playerId]
    pickNo: 0,                   // 0-based overall pick counter
    clockTimer: null,
    categories: [],              // {id, text}
    votingOpen: false,
    votes: {},                   // categoryId -> { voterId: teamId }
    results: null,               // computed on reveal
  };
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, teamName: p.teamName || p.name, connected: p.connected, isHost: p.id === roomOf(p)?.hostId };
}
function roomOf() { return null; } // placeholder, not used

function totalPicks(room) { return room.order.length * room.settings.rosterSize; }

// snake: which team is on the clock for a given overall pickNo
function teamOnClock(room, pickNo) {
  const n = room.order.length;
  if (n === 0) return null;
  const round = Math.floor(pickNo / n);
  const idxInRound = pickNo % n;
  const idx = (round % 2 === 0) ? idxInRound : (n - 1 - idxInRound);
  return room.order[idx];
}

function buildState(room) {
  const n = room.order.length;
  const onClock = room.phase === 'draft' && room.pickNo < totalPicks(room) ? teamOnClock(room, room.pickNo) : null;
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    settings: room.settings,
    players: room.players.map(p => ({ id: p.id, name: p.name, teamName: p.teamName || p.name, connected: p.connected })),
    order: room.order,
    picks: room.picks,
    drafted: [...room.drafted],
    rosters: room.rosters,
    pickNo: room.pickNo,
    totalPicks: totalPicks(room),
    round: n ? Math.floor(room.pickNo / n) + 1 : 0,
    rounds: room.settings.rosterSize,
    onClock,
    clockEnds: room.clockEnds || null,
    categories: room.categories,
    votingOpen: room.votingOpen,
    votes: room.votes,
    results: room.results,
  };
}

function broadcast(room) {
  room.lastActivity = Date.now();
  markDirty();
  const msg = JSON.stringify({ type: 'state', state: buildState(room) });
  for (const p of room.players) {
    if (p.connected && p.ws && p.ws.readyState === 1) {
      try { p.ws.send(msg); } catch (e) {}
    }
  }
}

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }

function clearClock(room) {
  if (room.clockTimer) { clearTimeout(room.clockTimer); room.clockTimer = null; }
  room.clockEnds = null;
}

function startClock(room) {
  clearClock(room);
  const secs = room.settings.pickSeconds;
  if (!secs || secs <= 0) return;
  if (room.phase !== 'draft' || room.pickNo >= totalPicks(room)) return;
  room.clockEnds = Date.now() + secs * 1000;
  room.clockTimer = setTimeout(() => {
    // auto-pick best available for team on the clock
    const teamId = teamOnClock(room, room.pickNo);
    const best = PLAYERS.find(p => !room.drafted.has(p.id));
    if (best) doPick(room, teamId, best.id, true);
  }, secs * 1000);
}

function doPick(room, teamId, playerId, auto = false) {
  if (room.phase !== 'draft') return false;
  if (room.pickNo >= totalPicks(room)) return false;
  if (teamOnClock(room, room.pickNo) !== teamId) return false;
  if (room.drafted.has(playerId)) return false;
  if (!PLAYER_BY_ID.has(playerId)) return false;
  const n = room.order.length;
  const round = Math.floor(room.pickNo / n) + 1;
  room.drafted.add(playerId);
  room.rosters[teamId] = room.rosters[teamId] || [];
  room.rosters[teamId].push(playerId);
  room.picks.push({ pickNo: room.pickNo + 1, round, teamId, playerId, auto });
  room.pickNo++;
  if (room.pickNo >= totalPicks(room)) {
    clearClock(room);
    room.phase = 'voting_setup';
  } else {
    startClock(room);
  }
  broadcast(room);
  return true;
}

function computeResults(room) {
  const res = {};
  for (const cat of room.categories) {
    const tally = {};
    for (const p of room.players) tally[p.id] = 0;
    const v = room.votes[cat.id] || {};
    for (const voter in v) {
      const t = v[voter];
      if (t in tally) tally[t]++;
    }
    let winner = null, max = -1, tie = false;
    for (const t in tally) {
      if (tally[t] > max) { max = tally[t]; winner = t; tie = false; }
      else if (tally[t] === max && max > 0) { tie = true; }
    }
    res[cat.id] = { tally, winner: max > 0 ? winner : null, tie: max > 0 ? tie : false, max };
  }
  return res;
}

// ---------- serialize & disk I/O ----------
function serializeRoom(r) {
  return {
    code: r.code, lastActivity: r.lastActivity, phase: r.phase, hostId: r.hostId,
    players: r.players.map(p => ({ id: p.id, token: p.token, name: p.name, teamName: p.teamName })),
    settings: r.settings, order: r.order, picks: r.picks,
    drafted: [...r.drafted], rosters: r.rosters, pickNo: r.pickNo,
    categories: r.categories, votingOpen: r.votingOpen, votes: r.votes, results: r.results,
  };
}
function deserializeRoom(o) {
  const r = newRoom(o.code);
  r.lastActivity = o.lastActivity || Date.now();
  r.phase = o.phase || 'lobby';
  r.hostId = o.hostId || null;
  r.players = (o.players || []).map(p => ({ id: p.id, token: p.token, name: p.name, teamName: p.teamName || p.name, connected: false, ws: null }));
  r.settings = o.settings || r.settings;
  r.order = o.order || [];
  r.picks = o.picks || [];
  r.drafted = new Set(o.drafted || []);
  r.rosters = o.rosters || {};
  r.pickNo = o.pickNo || 0;
  r.categories = o.categories || [];
  r.votingOpen = !!o.votingOpen;
  r.votes = o.votes || {};
  r.results = o.results || null;
  return r;
}
function loadRooms() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return 0;
    const arr = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    let n = 0;
    for (const o of arr) {
      if (!o || !o.code) continue;
      // drop stale or empty rooms on load
      if (Date.now() - (o.lastActivity || 0) > ROOM_TTL_MS) continue;
      if (!o.players || o.players.length === 0) continue;
      const r = deserializeRoom(o);
      rooms.set(r.code, r);
      if (r.phase === 'draft') startClock(r); // resume any pick clock fresh
      n++;
    }
    return n;
  } catch (e) { console.error('  Could not load saved rooms:', e.message); return 0; }
}
function flushRooms(force) {
  if (!SAVE_DIRTY && !force) return;
  SAVE_DIRTY = false;
  try {
    const arr = [...rooms.values()].map(serializeRoom);
    fs.writeFileSync(SAVE_FILE, JSON.stringify(arr));
  } catch (e) { console.error('  Save failed:', e.message); SAVE_DIRTY = true; }
}
function sweepRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) { clearClock(room); rooms.delete(code); markDirty(); }
  }
}

// ---------- websocket handling ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const t = msg.type;

    if (t === 'create') {
      const code = genCode();
      const room = newRoom(code);
      rooms.set(code, room);
      const player = { id: uid(), token: uid(), name: (msg.name || 'Host').slice(0,24), teamName: (msg.name||'Host').slice(0,24), connected: true, ws };
      room.players.push(player);
      room.hostId = player.id;
      ws.roomCode = code; ws.playerId = player.id;
      send(ws, { type: 'joined', roomCode: code, playerId: player.id, token: player.token, isHost: true });
      broadcast(room);
      return;
    }

    if (t === 'join') {
      const room = rooms.get((msg.roomCode || '').toUpperCase());
      if (!room) return send(ws, { type: 'error', message: 'Room not found.' });
      if (room.phase !== 'lobby') return send(ws, { type: 'error', message: 'That draft has already started.' });
      if (room.players.length >= 16) return send(ws, { type: 'error', message: 'Room is full (16 max).' });
      const nm = (msg.name || 'Player').slice(0,24);
      const player = { id: uid(), token: uid(), name: nm, teamName: nm, connected: true, ws };
      room.players.push(player);
      ws.roomCode = room.code; ws.playerId = player.id;
      send(ws, { type: 'joined', roomCode: room.code, playerId: player.id, token: player.token, isHost: false });
      broadcast(room);
      return;
    }

    if (t === 'rejoin') {
      const room = rooms.get((msg.roomCode || '').toUpperCase());
      if (!room) return send(ws, { type: 'error', message: 'Room no longer exists.', fatal: true });
      const player = room.players.find(p => p.token === msg.token);
      if (!player) return send(ws, { type: 'error', message: 'Could not rejoin.', fatal: true });
      player.connected = true; player.ws = ws;
      ws.roomCode = room.code; ws.playerId = player.id;
      send(ws, { type: 'joined', roomCode: room.code, playerId: player.id, token: player.token, isHost: player.id === room.hostId });
      broadcast(room);
      return;
    }

    // all following require an active room+player
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const me = room.players.find(p => p.id === ws.playerId);
    if (!me) return;
    const isHost = me.id === room.hostId;

    if (t === 'setTeamName') {
      me.teamName = (msg.name || me.name).slice(0,28) || me.name;
      broadcast(room);
      return;
    }

    if (t === 'config' && isHost && room.phase === 'lobby') {
      const rs = parseInt(msg.rosterSize, 10);
      const ps = parseInt(msg.pickSeconds, 10);
      if (rs >= 1 && rs <= 15) room.settings.rosterSize = rs;
      if (!isNaN(ps) && ps >= 0 && ps <= 600) room.settings.pickSeconds = ps;
      broadcast(room);
      return;
    }

    if (t === 'kick' && isHost && room.phase === 'lobby') {
      const idx = room.players.findIndex(p => p.id === msg.playerId);
      if (idx >= 0 && room.players[idx].id !== room.hostId) {
        const kicked = room.players[idx];
        if (kicked.ws) send(kicked.ws, { type: 'error', message: 'You were removed from the room.', fatal: true });
        room.players.splice(idx, 1);
        broadcast(room);
      }
      return;
    }

    if (t === 'startDraft' && isHost && room.phase === 'lobby') {
      if (room.players.length < 2) return send(ws, { type: 'error', message: 'Need at least 2 drafters.' });
      // draft order: use provided order (ids) or shuffle
      let ids = room.players.map(p => p.id);
      if (Array.isArray(msg.order) && msg.order.length === ids.length && msg.order.every(id => ids.includes(id))) {
        ids = msg.order;
      } else {
        for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [ids[i],ids[j]]=[ids[j],ids[i]]; }
      }
      room.order = ids;
      room.rosters = {}; ids.forEach(id => room.rosters[id] = []);
      room.picks = []; room.drafted = new Set(); room.pickNo = 0;
      room.phase = 'draft';
      startClock(room);
      broadcast(room);
      return;
    }

    if (t === 'pick') {
      // only the team on the clock (or host acting for them) may pick
      const onClock = teamOnClock(room, room.pickNo);
      const actingFor = msg.teamId || me.id;
      const allowed = (actingFor === me.id) || isHost;
      if (!allowed) return;
      if (onClock !== actingFor) return send(ws, { type: 'error', message: 'Not that team\'s pick.' });
      const ok = doPick(room, actingFor, msg.playerId);
      if (!ok) send(ws, { type: 'error', message: 'Invalid pick.' });
      return;
    }

    if (t === 'addCategory' && isHost && (room.phase === 'voting_setup' || room.phase === 'voting')) {
      const text = (msg.text || '').trim().slice(0,60);
      if (text && room.categories.length < 30) {
        room.categories.push({ id: uid(), text });
        broadcast(room);
      }
      return;
    }
    if (t === 'removeCategory' && isHost && room.phase !== 'results') {
      room.categories = room.categories.filter(c => c.id !== msg.id);
      delete room.votes[msg.id];
      broadcast(room);
      return;
    }

    if (t === 'openVoting' && isHost && room.phase === 'voting_setup') {
      if (room.categories.length === 0) return send(ws, { type: 'error', message: 'Add at least one category.' });
      room.phase = 'voting';
      room.votingOpen = true;
      room.votes = {};
      broadcast(room);
      return;
    }

    if (t === 'vote' && room.phase === 'voting' && room.votingOpen) {
      const cat = room.categories.find(c => c.id === msg.categoryId);
      const target = room.players.find(p => p.id === msg.teamId);
      if (!cat || !target) return;
      room.votes[cat.id] = room.votes[cat.id] || {};
      room.votes[cat.id][me.id] = target.id;
      broadcast(room);
      return;
    }

    if (t === 'revealResults' && isHost && room.phase === 'voting') {
      room.votingOpen = false;
      room.results = computeResults(room);
      room.phase = 'results';
      broadcast(room);
      return;
    }

    if (t === 'backToVoting' && isHost && room.phase === 'results') {
      room.phase = 'voting'; room.votingOpen = true; room.results = null;
      broadcast(room);
      return;
    }

    if (t === 'newGame' && isHost) {
      room.phase = 'lobby';
      room.order = []; room.picks = []; room.drafted = new Set(); room.rosters = {}; room.pickNo = 0;
      room.categories = []; room.votes = {}; room.results = null; room.votingOpen = false;
      clearClock(room);
      broadcast(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const me = room.players.find(p => p.id === ws.playerId);
    if (!me) return;
    me.connected = false; me.ws = null;
    // in lobby, drop the player entirely
    if (room.phase === 'lobby') {
      room.players = room.players.filter(p => p.id !== me.id);
    }
    // transfer host if needed
    if (room.hostId === me.id) {
      const next = room.players.find(p => p.connected);
      if (next) room.hostId = next.id;
    }
    // clean up empty rooms
    if (room.players.length === 0 || room.players.every(p => !p.connected)) {
      if (room.players.length === 0) { clearClock(room); rooms.delete(room.code); markDirty(); return; }
    }
    broadcast(room);
  });
});

// broadcast a clock tick so clients stay in sync (light)
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase === 'draft' && room.clockEnds) broadcast(room);
  }
}, 1000);

const RESTORED = loadRooms();
// periodic save + staleness sweep
setInterval(() => { sweepRooms(); flushRooms(false); }, 3000);
function shutdown() { flushRooms(true); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`\n  🏀  NBA All-Time Draft running`);
  console.log(`      Local:   http://localhost:${PORT}`);
  console.log(`      Network: http://<your-LAN-IP>:${PORT}  (share this with players on your WiFi)\n`);
  console.log(`      ${PLAYERS.length} players loaded.` + (RESTORED ? `  Restored ${RESTORED} saved room(s).` : '') + `\n`);
});
