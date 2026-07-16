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
const SHOOT_RANGE = 6;
const SHOOT_WIDTH = 1.2;

const rooms = new Map();
const clients = new Map();

class Room {
  constructor(settings) {
    this.id = uuidv4().slice(0, 6);
    this.name = settings.name;
    this.map = settings.map || 'minecraft';
    this.maxPlayers = settings.maxPlayers || 4;
    this.hiderPrepTime = settings.hiderPrepTime || 20;
    this.seekerTime = settings.seekerTime || 45;
    this.public = settings.public !== false;
    this.password = settings.password || '';
    this.players = [];
    this.state = 'lobby';
    this.seekerId = null;
    this.roundStart = 0;
    this.timer = null;
    this.eliminated = new Set();
  }

  addPlayer(ws) {
    const player = {
      ws,
      id: uuidv4().slice(0, 4),
      role: this.players.length === 0 ? 'seeker' : 'hider',
      x: this.players.length === 0 ? 6 : 2,
      z: this.players.length === 0 ? 6 : 2,
      color: 0xffffff,
      frozen: false,
      score: 0
    };
    this.players.push(player);
    if (player.role === 'seeker') this.seekerId = player.id;
    return player;
  }

  removePlayer(ws) {
    const idx = this.players.findIndex(p => p.ws === ws);
    if (idx === -1) return;
    const removed = this.players.splice(idx, 1)[0];
    if (removed.id === this.seekerId && this.players.length > 0) {
      this.seekerId = this.players[0].id;
      this.players[0].role = 'seeker';
    }
    return removed;
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
        ? Math.max(0, this.seekerTime - Math.floor((Date.now() - this.roundStart) / 1000))
        : null,
    }));
  }

  broadcastState() {
    this.players.forEach(p => {
      if (p.ws.readyState === WebSocket.OPEN) this.sendStateTo(p.ws);
    });
  }

  broadcast(msg) {
    this.players.forEach(p => {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
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
    this.broadcast({ type: 'phase', phase: 'preparing', time: this.hiderPrepTime });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.startSeeking(), this.hiderPrepTime * 1000);
  }

  startSeeking() {
    this.state = 'seeking';
    this.roundStart = Date.now();
    this.players.forEach(p => {
      if (p.role === 'hider') p.frozen = true;
    });
    this.broadcastState();
    this.broadcast({ type: 'phase', phase: 'seeking', time: this.seekerTime });
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
      else this.players
        .filter(p => p.role === 'hider' && !this.eliminated.has(p.id))
        .forEach(h => (h.score += 1));
    }
    this.broadcast({ type: 'roundEnd', caught, scores: this.getScores() });
    const hiders = this.players.filter(p => p.role === 'hider' && !this.eliminated.has(p.id));
    if (hiders.length > 0) {
      const newSeeker = hiders[Math.floor(Math.random() * hiders.length)];
      newSeeker.role = 'seeker';
      const old = this.players.find(p => p.id === this.seekerId);
      if (old) old.role = 'hider';
      this.seekerId = newSeeker.id;
    }
    this.state = 'lobby';
    this.broadcastState();
  }

  handleMove(ws, x, z) {
    const p = this.getPlayer(ws);
    if (!p || (p.frozen && p.role === 'hider')) return;
    p.x = x;
    p.z = z;
    this.broadcastState();
  }

  handleColor(ws, color) {
    const p = this.getPlayer(ws);
    if (!p || p.frozen || (p.role !== 'hider' && p.role !== 'seeker')) return;
    if (p.role === 'seeker' && this.state !== 'preparing') return;
    if (p.role === 'hider' && this.state !== 'preparing') return;
    p.color = color;
    this.broadcastState();
  }

  handleFreeze(ws) {
    const p = this.getPlayer(ws);
    if (!p || p.role !== 'hider' || p.frozen || this.state !== 'preparing') return;
    p.frozen = true;
    this.broadcastState();
  }

  handleCatch(ws) {
    const p = this.getPlayer(ws);
    if (!p || p.role !== 'seeker' || this.state !== 'seeking') return;
    let caught = false;
    this.players.forEach(h => {
      if (h.role !== 'hider' || this.eliminated.has(h.id)) return;
      const dx = p.x - h.x;
      const dz = p.z - h.z;
      if (Math.sqrt(dx * dx + dz * dz) < CATCH_DISTANCE) {
        this.eliminated.add(h.id);
        caught = true;
        ws.send(JSON.stringify({ type: 'catchSuccess', victimId: h.id }));
      }
    });
    if (caught) {
      this.broadcastState();
      const hidersLeft = this.players.filter(p => p.role === 'hider' && !this.eliminated.has(p.id));
      if (hidersLeft.length === 0) this.endRound(true);
    } else {
      ws.send(JSON.stringify({ type: 'catchFail', message: 'Kimse yok!' }));
    }
  }

  handleShoot(ws, data) {
    const p = this.getPlayer(ws);
    if (!p || p.role !== 'seeker' || this.state !== 'seeking') return;
    const dir = data.dir;
    const origin = data.origin;
    let hit = false;
    this.players.forEach(h => {
      if (h.role !== 'hider' || this.eliminated.has(h.id)) return;
      const dx = h.x - origin.x;
      const dz = h.z - origin.z;
      const proj = dx * dir.x + dz * dir.z;
      const perp = Math.sqrt(Math.max(0, dx * dx + dz * dz - proj * proj));
      if (proj > 0 && proj < SHOOT_RANGE && perp < SHOOT_WIDTH) {
        this.eliminated.add(h.id);
        hit = true;
        ws.send(JSON.stringify({ type: 'catchSuccess', victimId: h.id }));
      }
    });
    if (hit) {
      this.broadcastState();
      const hidersLeft = this.players.filter(p => p.role === 'hider' && !this.eliminated.has(p.id));
      if (hidersLeft.length === 0) this.endRound(true);
    } else {
      ws.send(JSON.stringify({ type: 'catchFail', message: 'Iskaladın!' }));
    }
  }
}

function broadcastRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.public) {
      list.push({
        id: room.id,
        name: room.name,
        map: room.map,
        players: room.players.length,
        max: room.maxPlayers,
        hasPassword: !!room.password,
      });
    }
  }
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify({ type: 'roomList', rooms: list }));
    }
  });
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }

    switch (data.type) {
      case 'createRoom': {
        const room = new Room(data.settings);
        rooms.set(room.id, room);
        const player = room.addPlayer(ws);
        clients.set(ws, { roomId: room.id, playerId: player.id });
        ws.send(JSON.stringify({ type: 'roomCreated', roomId: room.id }));
        broadcastRoomList();
        room.sendStateTo(ws);
        break;
      }
      case 'joinRoom': {
        const room = [...rooms.values()].find(r => r.name === data.roomName);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Oda bulunamadı.' }));
          break;
        }
        if (room.players.length >= room.maxPlayers) {
          ws.send(JSON.stringify({ type: 'error', message: 'Oda dolu.' }));
          break;
        }
        if (!room.public && room.password !== data.password) {
          ws.send(JSON.stringify({ type: 'error', message: 'Yanlış şifre.' }));
          break;
        }
        const player = room.addPlayer(ws);
        clients.set(ws, { roomId: room.id, playerId: player.id });
        ws.send(JSON.stringify({ type: 'roomJoined', roomId: room.id }));
        room.broadcastState();
        broadcastRoomList();
        break;
      }
      case 'startGame': {
        const info = clients.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomId);
        if (room && room.getPlayer(ws)?.role === 'seeker') {
          room.startGame();
        }
        break;
      }
      case 'move': {
        const info = clients.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomId);
        if (room) room.handleMove(ws, data.x, data.z);
        break;
      }
      case 'color': {
        const info = clients.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomId);
        if (room) room.handleColor(ws, data.color);
        break;
      }
      case 'freeze': {
        const info = clients.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomId);
        if (room) room.handleFreeze(ws);
        break;
      }
      case 'catch': {
        const info = clients.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomId);
        if (room) room.handleCatch(ws);
        break;
      }
      case 'shoot': {
        const info = clients.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomId);
        if (room) room.handleShoot(ws, data);
        break;
      }
      case 'leaveRoom': {
        const info = clients.get(ws);
        if (!info) break;
        const room = rooms.get(info.roomId);
        if (room) {
          room.removePlayer(ws);
          if (room.players.length === 0) {
            rooms.delete(room.id);
          } else {
            room.broadcastState();
          }
        }
        clients.delete(ws);
        broadcastRoomList();
        break;
      }
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      const room = rooms.get(info.roomId);
      if (room) {
        room.removePlayer(ws);
        if (room.players.length === 0) {
          rooms.delete(room.id);
        } else {
          room.broadcastState();
        }
      }
      clients.delete(ws);
      broadcastRoomList();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Sunucu ${PORT} portunda çalışıyor`));