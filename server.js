const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, 'public')));

// --- Oyun sabitleri ---
const CATCH_DISTANCE = 2.0;
const MAPS = {
  minecraft: {
    spawns: [{ x: -3, z: -3 }, { x: 3, z: 3 }, { x: 0, z: 0 }],
    objects: [
      { type: 'box', size: [1,1,1], pos: [0,0.5,0], color: 0x8B4513 },
      { type: 'box', size: [2,1,2], pos: [-2,0.5,2], color: 0x228B22 },
      { type: 'box', size: [0.8,1.5,0.8], pos: [2.5,0.75,-1], color: 0xFFD700 },
      { type: 'sphere', radius: 0.6, pos: [-2.5,0.6,-2], color: 0xFF4500 },
      { type: 'cylinder', radiusTop:0.4, radiusBottom:0.4, height:1.2, pos: [0,0.6,2.5], color: 0x4B0082 }
    ]
  },
  ev: {
    spawns: [{ x: -2, z: 0 }, { x: 2, z: 1 }, { x: 0, z: -2 }],
    objects: [
      { type: 'box', size: [0.5,0.8,0.5], pos: [0.5,0.4,1], color: 0x8B0000 },
      { type: 'box', size: [1,0.3,1.5], pos: [-1.5,0.15,0], color: 0x5C4033 },
      { type: 'cylinder', radiusTop:0.3, radiusBottom:0.3, height:1.5, pos: [1.2,0.75,-1], color: 0x708090 },
      { type: 'sphere', radius:0.5, pos: [-0.8,0.5,-1.8], color: 0xFF69B4 },
      { type: 'box', size: [1.2,0.6,0.6], pos: [2,0.3,1.5], color: 0x556B2F }
    ]
  }
};

// --- Oda yönetimi ---
const rooms = new Map(); // roomId -> room object
const players = new Map(); // ws -> { id, roomId, playerData }

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
    this.players = []; // { ws, id, role, x, z, color, frozen, score }
    this.state = 'lobby'; // lobby | preparing | seeking | ended
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
      role: this.players.length === 0 ? 'seeker' : 'hider', // ilk giren ebe
      x: 0,
      z: 0,
      color: 0xffffff,
      frozen: false,
      score: 0
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
        // yeni ebe ata
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

  broadcast(msg, excludeWs = null) {
    this.players.forEach(p => {
      if (p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify(msg));
      }
    });
  }

  sendToAll(msg) {
    this.players.forEach(p => {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
    });
  }

  startGame() {
    if (this.state !== 'lobby') return;
    this.state = 'preparing';
    this.eliminated.clear();
    this.players.forEach(p => { p.frozen = false; p.color = 0xffffff; });
    this.sendToAll({ type: 'phase', phase: 'preparing', time: this.hiderPrepTime });
    this.timer = setTimeout(() => this.startSeeking(), this.hiderPrepTime * 1000);
  }

  startSeeking() {
    this.state = 'seeking';
    // donmayan hider'ları dondur
    this.players.forEach(p => { if (p.role === 'hider') p.frozen = true; });
    this.roundStartTime = Date.now();
    this.sendToAll({ type: 'phase', phase: 'seeking', time: this.seekerTime });
    this.timer = setTimeout(() => this.endRound(false), this.seekerTime * 1000);
  }

  endRound(caught) {
    if (this.state !== 'seeking') return;
    clearTimeout(this.timer);
    this.state = 'ended';
    // puanları güncelle
    const seeker = this.players.find(p => p.id === this.seekerId);
    if (seeker) {
      if (caught) seeker.score += 1;
      else this.players.filter(p => p.role === 'hider').forEach(h => h.score += 1);
    }
    // rolleri değiştir: yeni ebe rastgele bir hider
    const hiders = this.players.filter(p => p.role === 'hider' && !this.eliminated.has(p.id));
    if (hiders.length > 0) {
      const newSeeker = hiders[Math.floor(Math.random() * hiders.length)];
      newSeeker.role = 'seeker';
      const oldSeeker = this.players.find(p => p.id === this.seekerId);
      if (oldSeeker) oldSeeker.role = 'hider';
      this.seekerId = newSeeker.id;
    }
    this.sendToAll({ type: 'roundEnd', caught, scores: this.getScores() });
    this.state = 'lobby';
  }

  getScores() {
    const s = {};
    this.players.forEach(p => { s[p.id] = p.score; });
    return s;
  }

  getStateForPlayer(playerWs) {
    const me = this.getPlayer(playerWs);
    return {
      roomId: this.id,
      name: this.name,
      map: this.map,
      state: this.state,
      players: this.players.map(p => ({
        id: p.id,
        role: p.role,
        x: p.x,
        z: p.z,
        color: p.color,
        frozen: p.frozen,
        eliminated: this.eliminated.has(p.id)
      })),
      myId: me ? me.id : null,
      myRole: me ? me.role : null,
      scores: this.getScores(),
      timeLeft: this.state === 'seeking' ? Math.max(0, this.seekerTime - Math.floor((Date.now() - this.roundStartTime)/1000)) : null
    };
  }
}

// --- WebSocket bağlantıları ---
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    switch (data.type) {
      case 'createRoom':
        handleCreateRoom(ws, data.settings);
        break;
      case 'joinRoom':
        handleJoinRoom(ws, data.roomName, data.password);
        break;
      case 'startGame':
        handleStartGame(ws);
        break;
      case 'move':
        handleMove(ws, data.x, data.z);
        break;
      case 'color':
        handleColor(ws, data.color);
        break;
      case 'freeze':
        handleFreeze(ws);
        break;
      case 'catch':
        handleCatch(ws);
        break;
      case 'leaveRoom':
        handleLeaveRoom(ws);
        break;
    }
  });

  ws.on('close', () => {
    handleLeaveRoom(ws);
  });
});

function handleCreateRoom(ws, settings) {
  if (!settings.name || !settings.map || !MAPS[settings.map]) {
    return ws.send(JSON.stringify({ type: 'error', message: 'Geçersiz ayarlar.' }));
  }
  const room = new Room({
    name: settings.name,
    map: settings.map,
    hiderPrepTime: settings.hiderPrepTime,
    seekerTime: settings.seekerTime,
    maxPlayers: settings.maxPlayers,
    public: settings.public,
    password: settings.password
  });
  rooms.set(room.id, room);
  const player = room.addPlayer(ws);
  players.set(ws, { roomId: room.id, playerId: player.id });
  ws.send(JSON.stringify({ type: 'roomCreated', roomId: room.id }));
  broadcastRoomList();
  // oda sahibine tam durum
  ws.send(JSON.stringify({ type: 'roomState', ...room.getStateForPlayer(ws) }));
}

function handleJoinRoom(ws, roomName, password) {
  // odayı isme göre bul
  let room = null;
  for (const r of rooms.values()) {
    if (r.name === roomName) { room = r; break; }
  }
  if (!room) return ws.send(JSON.stringify({ type: 'error', message: 'Oda bulunamadı.' }));
  if (room.players.length >= room.maxPlayers) return ws.send(JSON.stringify({ type: 'error', message: 'Oda dolu.' }));
  if (!room.public && room.password !== password) return ws.send(JSON.stringify({ type: 'error', message: 'Yanlış şifre.' }));
  
  const player = room.addPlayer(ws);
  players.set(ws, { roomId: room.id, playerId: player.id });
  ws.send(JSON.stringify({ type: 'roomJoined', roomId: room.id }));
  room.sendToAll({ type: 'roomState', ...room.getStateForPlayer(null) });
  broadcastRoomList();
}

function handleStartGame(ws) {
  const info = players.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (!room) return;
  const player = room.getPlayer(ws);
  if (player && player.role === 'seeker') {
    room.startGame();
  }
}

function handleMove(ws, x, z) {
  const info = players.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (!room || room.state === 'ended') return;
  const player = room.getPlayer(ws);
  if (!player) return;
  if (player.frozen && player.role === 'hider') return;
  player.x = x;
  player.z = z;
  room.sendToAll({ type: 'roomState', ...room.getStateForPlayer(null) });
}

function handleColor(ws, color) {
  const info = players.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (!room || room.state !== 'preparing') return;
  const player = room.getPlayer(ws);
  if (player && player.role === 'hider' && !player.frozen) {
    player.color = color;
    room.sendToAll({ type: 'roomState', ...room.getStateForPlayer(null) });
  }
}

function handleFreeze(ws) {
  const info = players.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (!room || room.state !== 'preparing') return;
  const player = room.getPlayer(ws);
  if (player && player.role === 'hider' && !player.frozen) {
    player.frozen = true;
    room.sendToAll({ type: 'roomState', ...room.getStateForPlayer(null) });
  }
}

function handleCatch(ws) {
  const info = players.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (!room || room.state !== 'seeking') return;
  const player = room.getPlayer(ws);
  if (!player || player.role !== 'seeker') return;

  let caughtSomeone = false;
  room.players.forEach(hider => {
    if (hider.role !== 'hider' || room.eliminated.has(hider.id)) return;
    const dx = player.x - hider.x;
    const dz = player.z - hider.z;
    if (Math.sqrt(dx*dx + dz*dz) < CATCH_DISTANCE) {
      room.eliminated.add(hider.id);
      caughtSomeone = true;
      ws.send(JSON.stringify({ type: 'catchSuccess', victimId: hider.id }));
    }
  });

  if (caughtSomeone) {
    room.sendToAll({ type: 'roomState', ...room.getStateForPlayer(null) });
    if (room.eliminated.size === room.players.filter(p => p.role === 'hider').length) {
      room.endRound(true);
    }
  } else {
    ws.send(JSON.stringify({ type: 'catchFail', message: 'Kimse yok!' }));
  }
}

function handleLeaveRoom(ws) {
  const info = players.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (!room) return;
  room.removePlayer(ws);
  players.delete(ws);
  if (room.players.length === 0) {
    rooms.delete(room.id);
  } else {
    room.sendToAll({ type: 'roomState', ...room.getStateForPlayer(null) });
  }
  broadcastRoomList();
}

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
        hasPassword: !!room.password
      });
    }
  }
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'roomList', rooms: roomList }));
    }
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));