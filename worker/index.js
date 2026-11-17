// NBA All-Time Draft — Cloudflare Workers port of server.js.
//
// The Worker serves public/ as static assets and hands every WebSocket upgrade to a
// single Durable Object ("global"), which plays the role of the old Node process:
// it holds every room, speaks the exact same message protocol, and persists each room
// to Durable Object storage on every change (instead of data/rooms.json on disk).
// The client (public/index.html) is unchanged.
import { DurableObject } from 'cloudflare:workers';
import PLAYERS from '../public/players.json';

const PLAYER_BY_ID = new Map(PLAYERS.map(p => [p.id, p]));
const ROOM_TTL_MS = 1000 * 60 * 60 * 48; // rooms untouched for 48h are pruned
const ROOM_KEY = code => 'room:' + code;

const uid = () => Math.random().toString(36).slice(2, 10);

function newRoom(code) {
  return {
    code,
    lastActivity: Date.now(),
    phase: 'lobby',              // lobby | draft | voting_setup | voting | results
    hostId: null,
    players: [],                 // {id, token, name, teamName, connected, ws}
    settings: { rosterSize: 12, pickSeconds: 0 },
    order: [],
    picks: [],
    drafted: new Set(),
    rosters: {},
    pickNo: 0,
    clockEnds: null,
    categories: [],
    votingOpen: false,
    votes: {},
    results: null,
  };
}

function totalPicks(room) { return room.order.length * room.settings.rosterSize; }

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

function serializeRoom(r) {
  return {
    code: r.code, lastActivity: r.lastActivity, phase: r.phase, hostId: r.hostId,
    players: r.players.map(p => ({ id: p.id, token: p.token, name: p.name, teamName: p.teamName })),
    settings: r.settings, order: r.order, picks: r.picks,
    drafted: [...r.drafted], rosters: r.rosters, pickNo: r.pickNo, clockEnds: r.clockEnds || null,
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
  r.clockEnds = o.clockEnds || null;
  r.categories = o.categories || [];
  r.votingOpen = !!o.votingOpen;
  r.votes = o.votes || {};
  r.results = o.results || null;
  return r;
}

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }

function getAtt(ws) { try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; } }
function setAtt(ws, att) { try { ws.serializeAttachment(att); } catch (e) {} }

export class DraftServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();
    this.ticker = null;
    // Load every saved room before handling anything (this also runs when the object
    // wakes from hibernation), then re-attach any sockets that stayed open.
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.list({ prefix: 'room:' });
      const now = Date.now();
      for (const [key, o] of saved) {
        if (!o || !o.code || now - (o.lastActivity || 0) > ROOM_TTL_MS || !o.players || o.players.length === 0) {
          await ctx.storage.delete(key);
          continue;
        }
        this.rooms.set(o.code, deserializeRoom(o));
      }
      for (const ws of ctx.getWebSockets()) {
        const att = getAtt(ws);
        const room = this.rooms.get(att.roomCode);
        const p = room && room.players.find(x => x.id === att.playerId);
        if (p) { p.ws = ws; p.connected = true; }
      }
      this.syncClocks();
    });
  }

  // ---------- persistence ----------
  save(room) { this.ctx.storage.put(ROOM_KEY(room.code), serializeRoom(room)); }
  drop(room) { this.rooms.delete(room.code); this.ctx.storage.delete(ROOM_KEY(room.code)); }

  broadcast(room, persist = true) {
    room.lastActivity = Date.now();
    if (persist) this.save(room);
    const msg = JSON.stringify({ type: 'state', state: buildState(room) });
    for (const p of room.players) {
      if (p.connected && p.ws) { try { p.ws.send(msg); } catch (e) {} }
    }
  }

  genCode() {
    let c;
    do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join(''); }
    while (this.rooms.has(c));
    return c;
  }

  // ---------- pick clock ----------
  // Same behaviour as the Node server: a deadline per room, auto-pick best available
  // when it passes, and a state broadcast every second while any clock is running.
  // A Durable Object alarm backs up the in-memory ticker so an expired clock still
  // fires if the object was evicted in between.
  clearClock(room) { room.clockEnds = null; }

  startClock(room) {
    this.clearClock(room);
    const secs = room.settings.pickSeconds;
    if (secs && secs > 0 && room.phase === 'draft' && room.pickNo < totalPicks(room)) {
      room.clockEnds = Date.now() + secs * 1000;
    }
    this.syncClocks();
  }

  syncClocks() {
    let earliest = null;
    for (const r of this.rooms.values()) {
      if (r.phase === 'draft' && r.clockEnds && (earliest === null || r.clockEnds < earliest)) earliest = r.clockEnds;
    }
    if (earliest === null) {
      if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
      this.ctx.storage.deleteAlarm();
      return;
    }
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), 1000);
    this.ctx.storage.setAlarm(earliest + 250);
  }

  tick() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.phase !== 'draft' || !room.clockEnds) continue;
      if (now >= room.clockEnds) {
        const teamId = teamOnClock(room, room.pickNo);
        const best = PLAYERS.find(p => !room.drafted.has(p.id));
        if (best) this.doPick(room, teamId, best.id, true);
        else { this.clearClock(room); this.broadcast(room); }
      } else {
        this.broadcast(room, false);
      }
    }
    this.syncClocks();
  }

  async alarm() { this.tick(); }

  doPick(room, teamId, playerId, auto = false) {
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
      this.clearClock(room);
      room.phase = 'voting_setup';
      this.syncClocks();
    } else {
      this.startClock(room);
    }
    this.broadcast(room);
    return true;
  }

  // ---------- websocket handling ----------
  async fetch(request) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    setAtt(server, { roomCode: null, playerId: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    const t = msg.type;

    if (t === 'create') {
      const code = this.genCode();
      const room = newRoom(code);
      this.rooms.set(code, room);
      const player = { id: uid(), token: uid(), name: (msg.name || 'Host').slice(0, 24), teamName: (msg.name || 'Host').slice(0, 24), connected: true, ws };
      room.players.push(player);
      room.hostId = player.id;
      setAtt(ws, { roomCode: code, playerId: player.id });
      send(ws, { type: 'joined', roomCode: code, playerId: player.id, token: player.token, isHost: true });
      this.broadcast(room);
      return;
    }

    if (t === 'join') {
      const room = this.rooms.get((msg.roomCode || '').toUpperCase());
      if (!room) return send(ws, { type: 'error', message: 'Room not found.' });
      if (room.phase !== 'lobby') return send(ws, { type: 'error', message: 'That draft has already started.' });
      if (room.players.length >= 16) return send(ws, { type: 'error', message: 'Room is full (16 max).' });
      const nm = (msg.name || 'Player').slice(0, 24);
      const player = { id: uid(), token: uid(), name: nm, teamName: nm, connected: true, ws };
      room.players.push(player);
      setAtt(ws, { roomCode: room.code, playerId: player.id });
      send(ws, { type: 'joined', roomCode: room.code, playerId: player.id, token: player.token, isHost: false });
      this.broadcast(room);
      return;
    }

    if (t === 'rejoin') {
      const room = this.rooms.get((msg.roomCode || '').toUpperCase());
      if (!room) return send(ws, { type: 'error', message: 'Room no longer exists.', fatal: true });
      const player = room.players.find(p => p.token === msg.token);
      if (!player) return send(ws, { type: 'error', message: 'Could not rejoin.', fatal: true });
      player.connected = true; player.ws = ws;
      setAtt(ws, { roomCode: room.code, playerId: player.id });
      send(ws, { type: 'joined', roomCode: room.code, playerId: player.id, token: player.token, isHost: player.id === room.hostId });
      this.broadcast(room);
      return;
    }

    // all following require an active room+player
    const att = getAtt(ws);
    const room = this.rooms.get(att.roomCode);
    if (!room) return;
    const me = room.players.find(p => p.id === att.playerId);
    if (!me) return;
    const isHost = me.id === room.hostId;

    if (t === 'setTeamName') {
      me.teamName = (msg.name || me.name).slice(0, 28) || me.name;
      this.broadcast(room);
      return;
    }

    if (t === 'config' && isHost && room.phase === 'lobby') {
      const rs = parseInt(msg.rosterSize, 10);
      const ps = parseInt(msg.pickSeconds, 10);
      if (rs >= 1 && rs <= 15) room.settings.rosterSize = rs;
      if (!isNaN(ps) && ps >= 0 && ps <= 600) room.settings.pickSeconds = ps;
      this.broadcast(room);
      return;
    }

    if (t === 'kick' && isHost && room.phase === 'lobby') {
      const idx = room.players.findIndex(p => p.id === msg.playerId);
      if (idx >= 0 && room.players[idx].id !== room.hostId) {
        const kicked = room.players[idx];
        if (kicked.ws) {
          send(kicked.ws, { type: 'error', message: 'You were removed from the room.', fatal: true });
          setAtt(kicked.ws, { roomCode: null, playerId: null });
        }
        room.players.splice(idx, 1);
        this.broadcast(room);
      }
      return;
    }

    if (t === 'startDraft' && isHost && room.phase === 'lobby') {
      if (room.players.length < 2) return send(ws, { type: 'error', message: 'Need at least 2 drafters.' });
      let ids = room.players.map(p => p.id);
      if (Array.isArray(msg.order) && msg.order.length === ids.length && msg.order.every(id => ids.includes(id))) {
        ids = msg.order;
      } else {
        for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      }
      room.order = ids;
      room.rosters = {}; ids.forEach(id => room.rosters[id] = []);
      room.picks = []; room.drafted = new Set(); room.pickNo = 0;
      room.phase = 'draft';
      this.startClock(room);
      this.broadcast(room);
      return;
    }

    if (t === 'pick') {
      const onClock = teamOnClock(room, room.pickNo);
      const actingFor = msg.teamId || me.id;
      const allowed = (actingFor === me.id) || isHost;
      if (!allowed) return;
      if (onClock !== actingFor) return send(ws, { type: 'error', message: 'Not that team\'s pick.' });
      const ok = this.doPick(room, actingFor, msg.playerId);
      if (!ok) send(ws, { type: 'error', message: 'Invalid pick.' });
      return;
    }

    if (t === 'addCategory' && isHost && (room.phase === 'voting_setup' || room.phase === 'voting')) {
      const text = (msg.text || '').trim().slice(0, 60);
      if (text && room.categories.length < 30) {
        room.categories.push({ id: uid(), text });
        this.broadcast(room);
      }
      return;
    }
    if (t === 'removeCategory' && isHost && room.phase !== 'results') {
      room.categories = room.categories.filter(c => c.id !== msg.id);
      delete room.votes[msg.id];
      this.broadcast(room);
      return;
    }

    if (t === 'openVoting' && isHost && room.phase === 'voting_setup') {
      if (room.categories.length === 0) return send(ws, { type: 'error', message: 'Add at least one category.' });
      room.phase = 'voting';
      room.votingOpen = true;
      room.votes = {};
      this.broadcast(room);
      return;
    }

    if (t === 'vote' && room.phase === 'voting' && room.votingOpen) {
      const cat = room.categories.find(c => c.id === msg.categoryId);
      const target = room.players.find(p => p.id === msg.teamId);
      if (!cat || !target) return;
      room.votes[cat.id] = room.votes[cat.id] || {};
      room.votes[cat.id][me.id] = target.id;
      this.broadcast(room);
      return;
    }

    if (t === 'revealResults' && isHost && room.phase === 'voting') {
      room.votingOpen = false;
      room.results = computeResults(room);
      room.phase = 'results';
      this.broadcast(room);
      return;
    }

    if (t === 'backToVoting' && isHost && room.phase === 'results') {
      room.phase = 'voting'; room.votingOpen = true; room.results = null;
      this.broadcast(room);
      return;
    }

    if (t === 'newGame' && isHost) {
      room.phase = 'lobby';
      room.order = []; room.picks = []; room.drafted = new Set(); room.rosters = {}; room.pickNo = 0;
      room.categories = []; room.votes = {}; room.results = null; room.votingOpen = false;
      this.clearClock(room);
      this.syncClocks();
      this.broadcast(room);
      return;
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (e) {}
    this.handleDisconnect(ws);
  }

  async webSocketError(ws) { this.handleDisconnect(ws); }

  handleDisconnect(ws) {
    const att = getAtt(ws);
    const room = this.rooms.get(att.roomCode);
    if (!room) return;
    const me = room.players.find(p => p.id === att.playerId);
    if (!me || me.ws !== ws) return; // a newer socket already took over this seat
    me.connected = false; me.ws = null;
    if (room.phase === 'lobby') {
      room.players = room.players.filter(p => p.id !== me.id);
    }
    if (room.hostId === me.id) {
      const next = room.players.find(p => p.connected);
      if (next) room.hostId = next.id;
    }
    if (room.players.length === 0) { this.drop(room); this.syncClocks(); return; }
    this.broadcast(room);
  }
}

export default {
  async fetch(request, env) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      const stub = env.DRAFT.get(env.DRAFT.idFromName('global'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
