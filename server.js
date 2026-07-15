const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, 'public')));

// ----- Oyun sabitleri -----
const ROUND_DURATION = 45; // saniye
const CATCH_DISTANCE = 1.8;
const MAP_BOUNDS = 8;
const COLORS = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff, 0xffaa00, 0xffffff];

// ----- Oda sistemi (basit: 2 oyunculu) -----
let waitingPlayer = null;
const rooms = new Map(); // roomId -> { players: Map(ws->player), state: 'preparing'|'seeking', hider: ws, seeker: ws, startTime, scores }

function createRoom(ws1, ws2) {
  const roomId = `room_${Date.now()}`;
  const room = {
    id: roomId,
    players: new Map(),
    state: 'preparing', // preparing | seeking
    hider: ws1,
    seeker: ws2,
    startTime: 0,
    scores: { hider: 0, seeker: 0 }
  };
  // Oyuncu verileri
  const p1 = { id: 1, role: 'hider', x: 0, z: 0, color: 0xffffff, frozen: false, score: 0 };
  const p2 = { id: 2, role: 'seeker', x: 2, z: 2, color: 0xffffff, frozen: false, score: 0 };
  room.players.set(ws1, p1);
  room.players.set(ws2, p2);
  rooms.set(roomId, room);
  return room;
}

function sendToRoom(room, msg) {
  room.players.forEach((_, ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  });
}

function startSeekingPhase(room) {
  room.state = 'seeking';
  room.startTime = Date.now();
  // Saklananı dondur (eğer donmadıysa otomatik don)
  const hiderData = room.players.get(room.hider);
  if (hiderData) {
    hiderData.frozen = true;
  }
  sendToRoom(room, { type: 'phase', phase: 'seeking', timeLeft: ROUND_DURATION });
}

function endRound(room, caught) {
  const hiderData = room.players.get(room.hider);
  const seekerData = room.players.get(room.seeker);
  if (caught) {
    seekerData.score += 1;
  } else {
    hiderData.score += 1;
  }
  sendToRoom(room, {
    type: 'roundEnd',
    caught,
    scores: { hider: hiderData.score, seeker: seekerData.score }
  });
  // Rolleri değiştir
  const oldHider = room.hider;
  room.hider = room.seeker;
  room.seeker = oldHider;
  const newHiderData = room.players.get(room.hider);
  const newSeekerData = room.players.get(room.seeker);
  newHiderData.role = 'hider';
  newHiderData.color = 0xffffff;
  newHiderData.frozen = false;
  newSeekerData.role = 'seeker';
  newSeekerData.frozen = false;
  room.state = 'preparing';
  sendToRoom(room, {
    type: 'phase',
    phase: 'preparing',
    roles: { you: newHiderData.role, opponent: newSeekerData.role },
    scores: { hider: newHiderData.score, seeker: newSeekerData.score }
  });
  // Süreyi sıfırla
  clearRoomTimer(room);
}

// Tur zamanlayıcısı
const roomTimers = new Map();
function setRoomTimer(room) {
  if (roomTimers.has(room.id)) clearTimeout(roomTimers.get(room.id));
  const timer = setTimeout(() => {
    if (room.state === 'seeking') {
      endRound(room, false); // yakalanmadı
    }
  }, ROUND_DURATION * 1000);
  roomTimers.set(room.id, timer);
}
function clearRoomTimer(room) {
  if (roomTimers.has(room.id)) {
    clearTimeout(roomTimers.get(room.id));
    roomTimers.delete(room.id);
  }
}

// ----- WebSocket bağlantıları -----
wss.on('connection', (ws) => {
  ws.isAlive = true;
  if (waitingPlayer && waitingPlayer !== ws && waitingPlayer.readyState === WebSocket.OPEN) {
    const room = createRoom(waitingPlayer, ws);
    waitingPlayer = null;
    // Her iki oyuncuya rollerini bildir
    room.players.forEach((player, client) => {
      client.send(JSON.stringify({
        type: 'roomAssigned',
        room: room.id,
        role: player.role,
        scores: { hider: 0, seeker: 0 },
        phase: 'preparing'
      }));
    });
  } else {
    waitingPlayer = ws;
    ws.send(JSON.stringify({ type: 'waiting' }));
  }

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    // Hangi odada olduğunu bul
    let currentRoom = null;
    for (const room of rooms.values()) {
      if (room.players.has(ws)) { currentRoom = room; break; }
    }
    if (!currentRoom) return;
    const player = currentRoom.players.get(ws);

    switch (data.type) {
      case 'move':
        if (player.frozen && player.role === 'hider') break; // donmuş saklanan hareket edemez
        player.x = data.x;
        player.z = data.z;
        break;
      case 'color':
        if (player.role === 'hider' && !player.frozen && currentRoom.state === 'preparing') {
          player.color = data.color;
        }
        break;
      case 'freeze':
        if (player.role === 'hider' && currentRoom.state === 'preparing') {
          player.frozen = true;
          // Eğer iki oyuncu da hazırsa arama fazı başlasın (seeker'ın hazır olmasına gerek yok)
          startSeekingPhase(currentRoom);
          setRoomTimer(currentRoom);
        }
        break;
      case 'catch':
        if (player.role === 'seeker' && currentRoom.state === 'seeking') {
          const hider = currentRoom.players.get(currentRoom.hider);
          const dx = player.x - hider.x;
          const dz = player.z - hider.z;
          const dist = Math.sqrt(dx*dx + dz*dz);
          if (dist < CATCH_DISTANCE) {
            endRound(currentRoom, true);
          } else {
            ws.send(JSON.stringify({ type: 'catchFail', message: 'Kimse yok!' }));
          }
        }
        break;
    }

    // Durum güncellemesini odadaki herkese gönder
    const playersState = [];
    currentRoom.players.forEach((p, client) => {
      playersState.push({
        id: p.id,
        role: p.role,
        x: p.x,
        z: p.z,
        color: p.color,
        frozen: p.frozen
      });
    });
    sendToRoom(currentRoom, {
      type: 'state',
      players: playersState,
      phase: currentRoom.state,
      timeLeft: currentRoom.state === 'seeking' ? Math.max(0, ROUND_DURATION - Math.floor((Date.now() - currentRoom.startTime)/1000)) : 0
    });
  });

  ws.on('close', () => {
    if (waitingPlayer === ws) waitingPlayer = null;
    for (const room of rooms.values()) {
      if (room.players.has(ws)) {
        sendToRoom(room, { type: 'opponentLeft' });
        clearRoomTimer(room);
        rooms.delete(room.id);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
