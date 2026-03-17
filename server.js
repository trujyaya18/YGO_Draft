// YGO Draft Server — serves game HTML + handles WebSocket draft
// Deploy: Railway, Render, Fly.io  |  npm install ws

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'index.html');

// ── HTTP: serve the game page ──
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Game file not found. Make sure index.html is in the same folder as server.js');
    }
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket: draft lobby ──
const wss = new WebSocketServer({ server });
const rooms = {};

function genCode() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function broadcast(roomCode, msg, excludeId = null) {
  const r = rooms[roomCode];
  if (!r) return;
  const data = JSON.stringify(msg);
  r.players.forEach(p => {
    if (p.ws && p.ws.readyState === 1 && p.id !== excludeId) {
      p.ws.send(data);
    }
  });
}

function broadcastAll(roomCode, msg) {
  broadcast(roomCode, msg, null);
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function roomState(roomCode) {
  const r = rooms[roomCode];
  return {
    type: 'room_state',
    code: roomCode,
    hostId: r.hostId,
    packPool: r.packPool,
    players: r.players.map(p => ({
      id: p.id,
      name: p.name,
      isAI: p.isAI,
      seat: p.seat,
      online: p.ws ? p.ws.readyState === 1 : false,
      deck: p.deck || [],
    })),
  };
}

wss.on('connection', (ws) => {
  ws.id = genCode() + genCode();
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'host': {
        const code = genCode();
        rooms[code] = {
          hostId: ws.id,
          players: [{ id: ws.id, name: msg.name || 'Host', isAI: false, seat: 0, ws, deck: [] }],
          packPool: [],
          draft: null,
        };
        ws.roomCode = code;
        send(ws, { type: 'hosted', code, playerId: ws.id });
        send(ws, roomState(code));
        console.log(`Room ${code} created by ${msg.name}`);
        break;
      }

      case 'join': {
        const r = rooms[msg.code];
        if (!r) { send(ws, { type: 'error', msg: 'Room not found. Check the code and try again.' }); return; }
        if (r.draft) { send(ws, { type: 'error', msg: 'Draft already in progress.' }); return; }
        if (r.players.filter(p => !p.isAI).length >= 6) { send(ws, { type: 'error', msg: 'Room is full (6 players max).' }); return; }
        // Check if reconnecting
        const existing = r.players.find(p => p.name === msg.name && !p.isAI && (!p.ws || p.ws.readyState !== 1));
        if (existing) {
          existing.ws = ws;
          ws.roomCode = msg.code;
          send(ws, { type: 'joined', code: msg.code, playerId: existing.id });
          broadcastAll(msg.code, roomState(msg.code));
          console.log(`${msg.name} reconnected to room ${msg.code}`);
          return;
        }
        ws.roomCode = msg.code;
        const seat = r.players.length;
        r.players.push({ id: ws.id, name: msg.name || `Player ${seat + 1}`, isAI: false, seat, ws, deck: [] });
        send(ws, { type: 'joined', code: msg.code, playerId: ws.id });
        broadcastAll(msg.code, roomState(msg.code));
        console.log(`${msg.name} joined room ${msg.code}`);
        break;
      }

      case 'update_pool': {
        const r = rooms[ws.roomCode];
        if (!r || r.hostId !== ws.id) return;
        r.packPool = msg.packPool || [];
        broadcastAll(ws.roomCode, roomState(ws.roomCode));
        break;
      }

      case 'add_ai': {
        const r = rooms[ws.roomCode];
        if (!r || r.hostId !== ws.id) return;
        if (r.players.length >= 6) { send(ws, { type: 'error', msg: 'Room full' }); return; }
        const aiId = 'AI_' + genCode();
        r.players.push({ id: aiId, name: msg.name || `AI ${r.players.filter(p => p.isAI).length + 1}`, isAI: true, seat: r.players.length, ws: null, deck: [] });
        broadcastAll(ws.roomCode, roomState(ws.roomCode));
        break;
      }

      case 'remove_player': {
        const r = rooms[ws.roomCode];
        if (!r || r.hostId !== ws.id) return;
        r.players = r.players.filter(p => p.id !== msg.playerId);
        r.players.forEach((p, i) => { p.seat = i; });
        broadcastAll(ws.roomCode, roomState(ws.roomCode));
        break;
      }

      case 'start_draft': {
        const r = rooms[ws.roomCode];
        if (!r || r.hostId !== ws.id) return;
        r.draft = { ppp: msg.ppp, passDir: msg.passDir };
        broadcastAll(ws.roomCode, {
          type: 'draft_started',
          allPacks: msg.allPacks,
          roundSets: msg.roundSets,
          ppp: msg.ppp,
          passDir: msg.passDir,
          players: r.players.map(p => ({ id: p.id, name: p.name, isAI: p.isAI, seat: p.seat, deck: [] })),
        });
        console.log(`Draft started in room ${ws.roomCode}`);
        break;
      }

      case 'pick': {
        const r = rooms[ws.roomCode];
        if (!r) return;
        // Relay to everyone EXCEPT sender (they already applied locally)
        broadcast(ws.roomCode, { type: 'pick_made', seat: msg.seat, cardName: msg.cardName, card: msg.card }, ws.id);
        break;
      }

      case 'draft_complete': {
        const r = rooms[ws.roomCode];
        if (!r) return;
        r.draft = null;
        broadcastAll(ws.roomCode, { type: 'draft_complete', players: msg.players });
        console.log(`Draft complete in room ${ws.roomCode}`);
        break;
      }

      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode || !rooms[ws.roomCode]) return;
    const r = rooms[ws.roomCode];
    const p = r.players.find(p => p.id === ws.id);
    if (p) p.ws = null;

    if (ws.id === r.hostId && !r.draft) {
      broadcastAll(ws.roomCode, { type: 'room_closed', msg: 'Host disconnected.' });
      delete rooms[ws.roomCode];
      console.log(`Room ${ws.roomCode} closed`);
    } else {
      broadcastAll(ws.roomCode, { type: 'player_disconnected', playerId: ws.id });
    }
  });
});

server.listen(PORT, () => console.log(`YGO Draft Server running on port ${PORT}`));
