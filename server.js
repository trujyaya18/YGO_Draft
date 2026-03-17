// YGO Draft Server — serves HTML + cards.json
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Your existing index.html as base64 (I'll keep this short in the response)
// You'll paste your full HTML here
const GAME_HTML = `<!DOCTYPE html>...`; // Your full HTML goes here

const server = http.createServer((req, res) => {
  // Serve the main game page
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(GAME_HTML);
    return;
  }
  
  // Serve cards.json
  if (req.method === 'GET' && req.url === '/cards.json') {
    const filePath = path.join(__dirname, 'cards.json');
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Cards data not found');
        return;
      }
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=3600'
      });
      res.end(data);
    });
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

// WebSocket server
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
    if (p.ws && p.ws.readyState === 1 && p.id !== excludeId) p.ws.send(data);
  });
}

function roomState(roomCode) {
  const r = rooms[roomCode];
  return {
    type: 'room_state',
    code: roomCode,
    hostId: r.hostId,
    packPool: r.packPool,
    players: r.players.map(p => ({
      id: p.id, name: p.name, isAI: p.isAI, seat: p.seat,
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
        ws.send(JSON.stringify({ type: 'hosted', code, playerId: ws.id }));
        ws.send(JSON.stringify(roomState(code)));
        console.log('Room', code, 'created by', msg.name);
        break;
      }

      case 'join': {
        const r = rooms[msg.code];
        if (!r) { ws.send(JSON.stringify({ type: 'error', msg: 'Room not found.' })); return; }
        if (r.draft) { ws.send(JSON.stringify({ type: 'error', msg: 'Draft already in progress.' })); return; }
        if (r.players.filter(p => !p.isAI).length >= 6) { ws.send(JSON.stringify({ type: 'error', msg: 'Room full.' })); return; }
        
        ws.roomCode = msg.code;
        const seat = r.players.length;
        r.players.push({ id: ws.id, name: msg.name || `Player ${seat+1}`, isAI: false, seat, ws, deck: [] });
        ws.send(JSON.stringify({ type: 'joined', code: msg.code, playerId: ws.id }));
        broadcast(msg.code, roomState(msg.code));
        break;
      }

      case 'update_pool': {
        const r = rooms[ws.roomCode];
        if (!r || r.hostId !== ws.id) return;
        r.packPool = msg.packPool || [];
        broadcast(ws.roomCode, roomState(ws.roomCode));
        break;
      }

      case 'add_ai': {
        const r = rooms[ws.roomCode];
        if (!r || r.hostId !== ws.id) return;
        if (r.players.length >= 6) { ws.send(JSON.stringify({ type: 'error', msg: 'Room full' })); return; }
        const aiId = 'AI_' + genCode();
        r.players.push({ id: aiId, name: msg.name || `AI ${r.players.filter(p=>p.isAI).length+1}`, isAI: true, seat: r.players.length, ws: null, deck: [] });
        broadcast(ws.roomCode, roomState(ws.roomCode));
        break;
      }

      case 'remove_player': {
        const r = rooms[ws.roomCode];
        if (!r || r.hostId !== ws.id) return;
        r.players = r.players.filter(p => p.id !== msg.playerId);
        r.players.forEach((p, i) => { p.seat = i; });
        broadcast(ws.roomCode, roomState(ws.roomCode));
        break;
      }

      case 'start_draft': {
        const r = rooms[ws.roomCode];
        if (!r || r.hostId !== ws.id) return;
        r.draft = { ppp: msg.ppp, passDir: msg.passDir };
        broadcast(ws.roomCode, {
          type: 'draft_started',
          allPacks: msg.allPacks,
          roundSets: msg.roundSets,
          ppp: msg.ppp,
          passDir: msg.passDir,
          players: r.players.map(p => ({ id: p.id, name: p.name, isAI: p.isAI, seat: p.seat, deck: [] })),
        });
        console.log('Draft started in room', ws.roomCode);
        break;
      }

      case 'pick': {
        broadcast(ws.roomCode, { type: 'pick_made', seat: msg.seat, cardName: msg.cardName, card: msg.card }, ws.id);
        break;
      }

      case 'draft_complete': {
        const r = rooms[ws.roomCode];
        if (!r) return;
        r.draft = null;
        broadcast(ws.roomCode, { type: 'draft_complete', players: msg.players });
        console.log('Draft complete in room', ws.roomCode);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode || !rooms[ws.roomCode]) return;
    const r = rooms[ws.roomCode];
    const p = r.players.find(p => p.id === ws.id);
    if (p) p.ws = null;
    if (ws.id === r.hostId && !r.draft) {
      broadcast(ws.roomCode, { type: 'room_closed', msg: 'Host disconnected.' });
      delete rooms[ws.roomCode];
    } else {
      broadcast(ws.roomCode, { type: 'player_disconnected', playerId: ws.id });
    }
  });
});

server.listen(PORT, () => console.log('YGO Draft Server on port', PORT));