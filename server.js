const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, 'public')));

const CATCH_DISTANCE = 2.0;

class Room {
  constructor(settings) {
    this.id = uuidv4().slice(0, 6);
    this.name = settings.name;
    this.map = settings.map;
    this.hiderPrepTime = settings.hiderPrepTime || 20;
    this.seekerTime = settings.seekerTime || 45;
    this.maxPlayers = settings.maxPlayers || 4;
    this.public = settings.public;
    this.password = settings.password || '';
    this.players = [];
    this.state = 'lobby';
    this.seekerId = null;
    this.roundStartTime = 0;
    this.timer = null;
    this.eliminated = new Set();
  }

  addPlayer(ws) {
    const playerId = uuidv4().slice(0, 4);
    const player = {
      ws,
      id: playerId,
      role: this.players.length === 0 ? 'seeker' : 'hider',
      x: 0, z: 0,
      color: 0xffffff,
      frozen: false,
      score: 0,
      lastMoveTime: 0,
    };
    this.players.push(player);
    if (player.role === 'seeker') this.seekerId = playerId;
    return player;
  }

  removePlayer(ws) {
    const idx = this.players.findIndex(p => p.ws === ws);
    if (idx !== -1) {
      const removed = this.players.splice(idx, 1)[0];
      if (removed.id === this.seekerId && this.players.length > 0) {
        this.seekerId = this.players[0].id;
        this.players[0].role = 'seeker';
      }
      return removed;
    }
    return null;
  }

  getPlayer(ws) {
    return this.players.find(p => p.ws === ws);
  }

  sendStateTo(ws) {
    const player = this.getPlayer(ws);
    if (!player) return;
    ws.send(JSON.stringify({
      type: 'roomState',
      roomId: this.id,
      name: this.name,
      map: this.map,
      state: this.state,
      myId: player.id,
      players: this.players.map(p => ({
        id: p.id,
        role: p.role,
        x: p.x,
        z: p.z,
        color: p.color,
        frozen: p.frozen,
        eliminated: this.eliminated.has(p.id),
        score: p.score,
      })),
      scores: this.getScores(),
      timeLeft: this.state === 'seeking'
        ? Math.max(0, this.seekerTime - Math.floor((Date.now() - this.roundStartTime) / 1000))
        : null,
    }));
  }

  broadcastState() {
    this.players.forEach(p => {
      if (p.ws.readyState === WebSocket.OPEN) this.sendStateTo(p.ws);
    });
  }

  getScores() {
    const s = {};
    this.players.forEach(p => (s[p.id] = p.score));
    return s;
  }

  startGame() {
    if (this.state !== 'lobby') return;
    this.state = 'preparing';
    this.eliminated.clear();
    this.players.forEach(p => {
      p.frozen = false;
      p.color = 0xffffff;
    });
    this.broadcastState();
    this.players.forEach(p => p.ws.send(JSON.stringify({
      type: 'phase', phase: 'preparing', time: this.hiderPrepTime
    })));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.startSeeking(), this.hiderPrepTime * 1000);
  }

  startSeeking() {
    this.state = 'seeking';
    this.players.forEach(p => { if (p.role === 'hider') p.frozen = true; });
    this.roundStartTime = Date.now();
    this.broadcastState();
    this.players.forEach(p => p.ws.send(JSON.stringify({
      type: 'phase', phase: 'seeking', time: this.seekerTime
    })));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.endRound(false), this.seekerTime * 1000);
  }

  endRound(caught) {
    if (this.state !== 'seeking') return;
    if (this.timer) clearTimeout(this.timer);
    this.state = 'ended';
    const seeker = this.players.find(p => p.id === this.seekerId);
    if (seeker) {
      if (caught) seeker.score += 1;
      else this.players.filter(p => p.role === 'hider' && !this.eliminated.has(p.id))
             .forEach(h => (h.score += 1));
    }
    const hiders = this.players.filter(p => p.role === 'hider' && !this.eliminated.has(p.id));
    if (hiders.length > 0) {
      const newSeeker = hiders[Math.floor(Math.random() * hiders.length)];
      newSeeker.role = 'seeker';
      const oldSeeker = this.players.find(p => p.id === this.seekerId);
      if (oldSeeker) oldSeeker.role = 'hider';
      this.seekerId = newSeeker.id;
    }
    this.players.forEach(p => p.ws.send(JSON.stringify({
      type: 'roundEnd', caught, scores: this.getScores()
    })));
    this.state = 'lobby';
    this.broadcastState();
  }
}

const rooms = new Map();
const playersMap = new Map();

function broadcastRoomList() {
  const roomList = [];
  for (const room of rooms.values()) {
    if (room.public) {
      roomList.push({
        id: room.id,
        name: room.name,
        map: room.map,
        players: room.players.length,
        maxPlayers: room.maxPlayers,
        hasPassword: !!room.password,
      });
    }
  }
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'roomList', rooms: roomList }));
    }
  });
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    switch (data.type) {
      case 'createRoom': handleCreateRoom(ws, data.settings); break;
      case 'joinRoom': handleJoinRoom(ws, data.roomName, data.password); break;
      case 'startGame': handleStartGame(ws); break;
      case 'move': handleMove(ws, data.x, data.z); break;
      case 'color': handleColor(ws, data.color); break;
      case 'freeze': handleFreeze(ws); break;
      case 'catch': handleCatch(ws); break;
      case 'leaveRoom': handleLeaveRoom(ws); break;
    }
  });

  ws.on('close', () => handleLeaveRoom(ws));
});

function handleCreateRoom(ws, settings) {
  if (!settings.name || !settings.map) {
    return ws.send(JSON.stringify({ type: 'error', message: 'Geçersiz ayarlar.' }));
  }
  const room = new Room(settings);
  rooms.set(room.id, room);
  const player = room.addPlayer(ws);
  playersMap.set(ws, { roomId: room.id, playerId: player.id });
  ws.send(JSON.stringify({ type: 'roomCreated', roomId: room.id }));
  broadcastRoomList();
  room.sendStateTo(ws);
}

function handleJoinRoom(ws, roomName, password) {
  let room = null;
  for (const r of rooms.values()) {
    if (r.name === roomName) { room = r; break; }
  }
  if (!room) return ws.send(JSON.stringify({ type: 'error', message: 'Oda bulunamadı.' }));
  if (room.players.length >= room.maxPlayers) return ws.send(JSON.stringify({ type: 'error', message: 'Oda dolu.' }));
  if (!room.public && room.password !== password) return ws.send(JSON.stringify({ type: 'error', message: 'Yanlış şifre.' }));

  const player = room.addPlayer(ws);
  playersMap.set(ws, { roomId: room.id, playerId: player.id });
  ws.send(JSON.stringify({ type: 'roomJoined', roomId: room.id }));
  room.broadcastState();
  broadcastRoomList();
}

function handleStartGame(ws) {
  const info = playersMap.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (!room) return;
  const player = room.getPlayer(ws);
  if (player && player.role === 'seeker') {
    room.startGame();
  }
}

function handleMove(ws, x, z) {
  const info = playersMap.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (!room || room.state === 'ended') return;
  const player = room.getPlayer(ws);
  if (!player) return;
  if (player.frozen && player.role === 'hider') return;

  // hile koruması olmadan direkt pozisyon güncelle
  player.x = x;
  player.z = z;
  room.broadcastState();
}

function handleColor(ws, color) {
  const info = playersMap.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (!room || room.state !== 'preparing') return;
  const player = room.getPlayer(ws);
  if (player && player.role === 'hider' && !player.frozen) {
    player.color = color;
    room.broadcastState();
  }
}

function handleFreeze(ws) {
  const info = playersMap.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (!room || room.state !== 'preparing') return;
  const player = room.getPlayer(ws);
  if (player && player.role === 'hider' && !player.frozen) {
    player.frozen = true;
    room.broadcastState();
  }
}

function handleCatch(ws) {
  const info = playersMap.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (!room || room.state !== 'seeking') return;
  const player = room.getPlayer(ws);
  if (!player || player.role !== 'seeker') return;

  let caughtAnyone = false;
  room.players.forEach(hider => {
    if (hider.role !== 'hider' || room.eliminated.has(hider.id)) return;
    const dx = player.x - hider.x;
    const dz = player.z - hider.z;
    if (Math.sqrt(dx * dx + dz * dz) < CATCH_DISTANCE) {
      room.eliminated.add(hider.id);
      caughtAnyone = true;
      ws.send(JSON.stringify({ type: 'catchSuccess', victimId: hider.id }));
    }
  });

  if (caughtAnyone) {
    room.broadcastState();
    const hidersLeft = room.players.filter(p => p.role === 'hider' && !room.eliminated.has(p.id));
    if (hidersLeft.length === 0) room.endRound(true);
  } else {
    ws.send(JSON.stringify({ type: 'catchFail', message: 'Kimse yok!' }));
  }
}

function handleLeaveRoom(ws) {
  const info = playersMap.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (!room) return;
  room.removePlayer(ws);
  playersMap.delete(ws);
  if (room.players.length === 0) {
    rooms.delete(room.id);
  } else {
    room.broadcastState();
  }
  broadcastRoomList();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));