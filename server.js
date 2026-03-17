const http = require("http");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

/* Load the real index.html */
const GAME_HTML = fs.readFileSync(
  path.join(__dirname, "index.html"),
  "utf8"
);

/* Load cards.json */
let CARDS_DATA;
try {
  CARDS_DATA = JSON.parse(
    fs.readFileSync(path.join(__dirname, "cards.json"), "utf8")
  );
} catch (e) {
  console.log("cards.json not found, using fallback");
  CARDS_DATA = { sets: [] };
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(GAME_HTML);
    return;
  }

  if (req.url === "/cards.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(CARDS_DATA));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocketServer({ server });

const rooms = {};

function genCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function broadcast(roomCode, data, exclude = null) {
  const room = rooms[roomCode];
  if (!room) return;

  const msg = JSON.stringify(data);

  room.players.forEach((p) => {
    if (
      p.ws &&
      p.ws.readyState === WebSocket.OPEN &&
      p.id !== exclude
    ) {
      p.ws.send(msg);
    }
  });
}

wss.on("connection", (ws) => {
  ws.id = genCode() + genCode();
  ws.roomCode = null;

  ws.on("message", (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "host") {
      const code = genCode();

      rooms[code] = {
        hostId: ws.id,
        players: [
          {
            id: ws.id,
            name: msg.name || "Host",
            ws,
            seat: 0,
            deck: [],
          },
        ],
        draft: null,
      };

      ws.roomCode = code;

      ws.send(
        JSON.stringify({
          type: "hosted",
          code,
          playerId: ws.id,
        })
      );
    }

    if (msg.type === "join") {
      const room = rooms[msg.code];
      if (!room) return;

      ws.roomCode = msg.code;

      const seat = room.players.length;

      room.players.push({
        id: ws.id,
        name: msg.name || "Player",
        ws,
        seat,
        deck: [],
      });

      broadcast(msg.code, {
        type: "player_joined",
        id: ws.id,
        name: msg.name,
      });
    }

    if (msg.type === "pick") {
      broadcast(
        ws.roomCode,
        {
          type: "pick_made",
          seat: msg.seat,
          card: msg.card,
        },
        ws.id
      );
    }
  });

  ws.on("close", () => {
    const room = rooms[ws.roomCode];
    if (!room) return;

    room.players = room.players.filter((p) => p.id !== ws.id);

    broadcast(ws.roomCode, {
      type: "player_left",
      id: ws.id,
    });
  });
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});