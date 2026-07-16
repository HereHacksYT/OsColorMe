const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map(); // roomId -> Room
const clients = new Map(); // ws -> { roomId, playerId }

class Room {
  constructor(settings) {
    this.id = uuidv4().slice(0, 6);
    this.name = settings.name;
    this.map = settings.map || 'minecraft';
    this.maxPlayers = settings.maxPlayers || 4;
    this.hiderTime = settings.hiderPrepTime || 20;
    this.seekerTime = settings.seekerTime || 45;
    this.public = settings.public !== false;
    this.password = settings.password || '';
    this.players = [];
    this.state = 'lobby'; // lobby | preparing | seeking | ended
    this.seekerId = null;
    this.timer = null;
    this.eliminated = new Set();
  }

  addPlayer(ws) {
    const player = {
      ws,
      id: uuidv4().slice(0, 4),
      role: this.players.length === 0 ? 'seeker' : 'hider',
      x: 0, z: 0,
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

  getPlayer(ws) { return this.players.find(p => p.ws === ws); }

  broadcast(msg) {
    this.players.forEach(p => p.ws.send(JSON.stringify(msg)));
  }

  sendState() {
    this.players.forEach(p => {
      const me = this.getPlayer(p.ws);
      p.ws.send(JSON.stringify({
        type: 'roomState',
        roomId: this.id,
        name: this.name,
        map: this.map,
        state: this.state,
        myId: me.id,
        players: this.players.map(pl => ({
          id: pl.id,
          role: pl.role,
          x: pl.x,
          z: pl.z,
          color: pl.color,
          frozen: pl.frozen,
          eliminated: this.eliminated.has(pl.id),
          score: pl.score
        })),
        scores: this.getScores(),
        timeLeft: this.state === 'seeking' ? Math.max(0, this.seekerTime - Math.floor((Date.now() - this.roundStart)/1000)) : null
      }));
    });
  }

  getScores() {
    const s = {};
    this.players.forEach(p => s[p.id] = p.score);
    return s;
  }

  startGame() {
    if (this.state !== 'lobby') return;
    this.state = 'preparing';
    this.eliminated.clear();
    this.players.forEach(p => { p.frozen = false; p.color = 0xffffff; });
    this.sendState();
    this.broadcast({ type: 'phase', phase: 'preparing', time: this.hiderTime });
    this.timer = setTimeout(() => this.startSeeking(), this.hiderTime * 1000);
  }

  startSeeking() {
    this.state = 'seeking';
    this.roundStart = Date.now();
    this.players.forEach(p => { if (p.role === 'hider') p.frozen = true; });
    this.sendState();
    this.broadcast({ type: 'phase', phase: 'seeking', time: this.seekerTime });
    this.timer = setTimeout(() => this.endRound(false), this.seekerTime * 1000);
  }

  endRound(caught) {
    if (this.state !== 'seeking') return;
    clearTimeout(this.timer);
    this.state = 'ended';
    const seeker = this.players.find(p => p.id === this.seekerId);
    if (seeker) {
      if (caught) seeker.score++;
      else this.players.filter(p => p.role === 'hider' && !this.eliminated.has(p.id)).forEach(h => h.score++);
    }
    this.broadcast({ type: 'roundEnd', caught, scores: this.getScores() });
    // rol değiştir
    const hiders = this.players.filter(p => p.role === 'hider' && !this.eliminated.has(p.id));
    if (hiders.length > 0) {
      const newSeeker = hiders[Math.floor(Math.random() * hiders.length)];
      newSeeker.role = 'seeker';
      const old = this.players.find(p => p.id === this.seekerId);
      if (old) old.role = 'hider';
      this.seekerId = newSeeker.id;
    }
    this.state = 'lobby';
    this.sendState();
  }

  handleMove(ws, x, z) {
    const p = this.getPlayer(ws);
    if (!p || (p.frozen && p.role === 'hider')) return;
    p.x = x; p.z = z;
    this.sendState();
  }

  handleColor(ws, color) {
    const p = this.getPlayer(ws);
    if (!p || p.role !== 'hider' || p.frozen || this.state !== 'preparing') return;
    p.color = color;
    this.sendState();
  }

  handleFreeze(ws) {
    const p = this.getPlayer(ws);
    if (!p || p.role !== 'hider' || p.frozen || this.state !== 'preparing') return;
    p.frozen = true;
    this.sendState();
  }

  handleCatch(ws) {
    const p = this.getPlayer(ws);
    if (!p || p.role !== 'seeker' || this.state !== 'seeking') return;
    let caught = false;
    this.players.forEach(h => {
      if (h.role !== 'hider' || this.eliminated.has(h.id)) return;
      if (Math.sqrt((p.x-h.x)**2 + (p.z-h.z)**2) < 2.0) {
        this.eliminated.add(h.id);
        caught = true;
        ws.send(JSON.stringify({ type: 'catchSuccess', victimId: h.id }));
      }
    });
    if (caught) {
      this.sendState();
      if ([...this.eliminated].length === this.players.filter(p=>p.role==='hider').length) this.endRound(true);
    } else ws.send(JSON.stringify({ type: 'catchFail', message: 'Kimse yok!' }));
  }
}

// Oda listesi
function broadcastRoomList() {
  const list = [];
  for (const r of rooms.values()) {
    if (r.public) list.push({ id: r.id, name: r.name, map: r.map, players: r.players.length, max: r.maxPlayers, hasPassword: !!r.password });
  }
  wss.clients.forEach(c => c.send(JSON.stringify({ type: 'roomList', rooms: list })));
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch(e){ return; }
    switch(data.type) {
      case 'createRoom': {
        const s = data.settings;
        const room = new Room(s);
        rooms.set(room.id, room);
        const player = room.addPlayer(ws);
        clients.set(ws, { roomId: room.id, playerId: player.id });
        ws.send(JSON.stringify({ type: 'roomCreated', roomId: room.id }));
        broadcastRoomList();
        room.sendState();
        break;
      }
      case 'joinRoom': {
        const room = [...rooms.values()].find(r => r.name === data.roomName);
        if (!room) return ws.send(JSON.stringify({ type: 'error', message: 'Oda bulunamadı' }));
        if (room.players.length >= room.maxPlayers) return ws.send(JSON.stringify({ type: 'error', message: 'Oda dolu' }));
        if (!room.public && room.password !== data.password) return ws.send(JSON.stringify({ type: 'error', message: 'Şifre yanlış' }));
        const player = room.addPlayer(ws);
        clients.set(ws, { roomId: room.id, playerId: player.id });
        ws.send(JSON.stringify({ type: 'roomJoined', roomId: room.id }));
        room.sendState();
        broadcastRoomList();
        break;
      }
      case 'startGame': {
        const info = clients.get(ws);
        if (!info) return;
        const room = rooms.get(info.roomId);
        if (room && room.getPlayer(ws)?.role === 'seeker') room.startGame();
        break;
      }
      case 'move': {
        const info = clients.get(ws);
        if (!info) return;
        rooms.get(info.roomId)?.handleMove(ws, data.x, data.z);
        break;
      }
      case 'color': {
        const info = clients.get(ws);
        if (!info) return;
        rooms.get(info.roomId)?.handleColor(ws, data.color);
        break;
      }
      case 'freeze': {
        const info = clients.get(ws);
        if (!info) return;
        rooms.get(info.roomId)?.handleFreeze(ws);
        break;
      }
      case 'catch': {
        const info = clients.get(ws);
        if (!info) return;
        rooms.get(info.roomId)?.handleCatch(ws);
        break;
      }
      case 'leaveRoom': {
        const info = clients.get(ws);
        if (!info) return;
        const room = rooms.get(info.roomId);
        if (room) {
          room.removePlayer(ws);
          if (room.players.length === 0) rooms.delete(room.id);
          else room.sendState();
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
        if (room.players.length === 0) rooms.delete(room.id);
        else room.sendState();
      }
      clients.delete(ws);
      broadcastRoomList();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sunucu ${PORT} portunda`));