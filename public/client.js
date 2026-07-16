import * as THREE from 'three';

// ---------- Bağlantı ----------
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${protocol}://${location.host}`;
let ws;
let myPlayerId = null;
let currentRoom = null;
let gameState = null;

// UI elemanları
const menuDiv = document.getElementById('menu');
const createForm = document.getElementById('create-form');
const joinForm = document.getElementById('join-form');
const gameUI = document.getElementById('game-ui');
const statusText = document.getElementById('status-text');
const timerDiv = document.getElementById('timer');
const scoresDiv = document.getElementById('scores');
const btnStart = document.getElementById('btn-start');
const hiderButtons = document.getElementById('hider-buttons');
const seekerButtons = document.getElementById('seeker-buttons');

// Three.js
let scene, camera, renderer;
let mapObjects = [];
let myFigure;
let remoteFigures = {};
let myColor = 0xffffff;
let frozen = false;

// Oda listesi
let currentRoomList = [];

// Sabit güncelleme (30 FPS)
const FIXED_FRAME_MS = 1000 / 30;
let gameInterval = null;

// --- Kamera ---
let cameraAngle = 0;           // yatay açı (radyan)
const CAMERA_DISTANCE = 12;   // %50 blok büyümesine uygun mesafe
const CAMERA_HEIGHT = 8;

// Çoklu dokunmatik için kimlikler
let joystickTouchId = null;
let cameraTouchId = null;
let cameraTouchStartX = 0;

// --- Harita & Çarpışma ---
const WORLD_LIMIT = 20;
const collisionBoxes = [];     // { min: Vector3, max: Vector3 }

// ---------- Bağlantı ----------
function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => console.log('Connected');
  ws.onmessage = handleServerMessage;
  ws.onclose = () => setTimeout(connect, 2000);
}
connect();

// ---------- Menü / Form ----------
// ... (önceki gibi, değişiklik yok)
document.getElementById('btn-create-room').onclick = () => {
  menuDiv.style.display = 'none';
  createForm.style.display = 'flex';
};
document.getElementById('btn-create-cancel').onclick = () => {
  createForm.style.display = 'none';
  menuDiv.style.display = 'flex';
};
document.getElementById('btn-join-room').onclick = () => {
  menuDiv.style.display = 'none';
  joinForm.style.display = 'flex';
  updateJoinSearchResults('');
};
document.getElementById('btn-join-cancel').onclick = () => {
  joinForm.style.display = 'none';
  menuDiv.style.display = 'flex';
};
document.querySelectorAll('input[name="visibility"]').forEach(r => {
  r.onchange = () => {
    document.getElementById('password-field').style.display =
      r.value === 'private' ? 'block' : 'none';
  };
});
document.getElementById('btn-create-confirm').onclick = () => {
  const name = document.getElementById('room-name').value.trim();
  if (!name) return alert('Oda ismi girin.');
  const map = document.getElementById('map-select').value;
  const hiderTime = parseInt(document.getElementById('hider-time').value);
  const seekerTime = parseInt(document.getElementById('seeker-time').value);
  const maxPlayers = parseInt(document.getElementById('max-players').value);
  const isPublic = document.querySelector('input[name="visibility"]:checked').value === 'public';
  const password = isPublic ? '' : document.getElementById('room-password').value;
  ws.send(JSON.stringify({
    type: 'createRoom',
    settings: { name, map, hiderPrepTime: hiderTime, seekerTime, maxPlayers, public: isPublic, password }
  }));
};
document.getElementById('btn-join-confirm').onclick = () => {
  const roomName = document.getElementById('join-room-name').value.trim();
  if (!roomName) return;
  const password = document.getElementById('join-password').value;
  ws.send(JSON.stringify({ type: 'joinRoom', roomName, password }));
};
document.getElementById('btn-leave').onclick = () => {
  ws.send(JSON.stringify({ type: 'leaveRoom' }));
  exitToMenu();
};
btnStart.onclick = () => ws.send(JSON.stringify({ type: 'startGame' }));

const joinNameInput = document.getElementById('join-room-name');
joinNameInput.addEventListener('input', () => {
  updateJoinSearchResults(joinNameInput.value.trim().toLowerCase());
});

function updateJoinSearchResults(query) {
  const resultsDiv = document.getElementById('search-results');
  const filtered = currentRoomList.filter(r => r.name.toLowerCase().includes(query));
  resultsDiv.innerHTML = filtered.map(r => `
    <div style="padding:6px; cursor:pointer; border-bottom:1px solid #555;"
         onclick="selectRoom('${r.name}', ${r.hasPassword})">
      ${r.name} (${r.players}/${r.maxPlayers}) - ${r.map} ${r.hasPassword ? '🔒' : ''}
    </div>
  `).join('');
}
window.selectRoom = (roomName, hasPassword) => {
  document.getElementById('join-room-name').value = roomName;
  document.getElementById('join-password').style.display = hasPassword ? 'block' : 'none';
  document.getElementById('search-results').innerHTML = '';
};
function updateRoomList(rooms) {
  currentRoomList = rooms;
  const listDiv = document.getElementById('room-list');
  listDiv.innerHTML = rooms.map(r => `
    <div style="padding:4px; cursor:pointer;"
         onclick="document.getElementById('join-room-name').value='${r.name}';
                  document.getElementById('join-form').style.display='flex';
                  menuDiv.style.display='none';
                  document.getElementById('join-password').style.display='${r.hasPassword ? 'block' : 'none}';">
      ${r.name} (${r.players}/${r.maxPlayers}) - ${r.map} ${r.hasPassword ? '🔒' : ''}
    </div>
  `).join('');
}

// ---------- Sunucu Mesajları ----------
function handleServerMessage(event) {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'roomList': updateRoomList(msg.rooms); break;
    case 'roomCreated': case 'roomJoined':
      currentRoom = msg.roomId;
      createForm.style.display = 'none';
      joinForm.style.display = 'none';
      menuDiv.style.display = 'none';
      break;
    case 'roomState': updateGameState(msg); break;
    case 'phase': handlePhaseChange(msg); break;
    case 'roundEnd': alert(msg.caught ? 'Yakalandınız!' : 'Kurtuldunuz!'); break;
    case 'catchFail': alert(msg.message); break;
    case 'error': alert(msg.message); break;
  }
}

// ---------- Oyun Durumu ----------
function updateGameState(state) {
  if (!scene) initScene(state.map);
  gameState = state;
  myPlayerId = state.myId;
  gameUI.style.display = 'block';

  const me = state.players.find(p => p.id === myPlayerId);
  statusText.innerText =
    state.state === 'lobby' ? 'Lobide bekleniyor...' :
    state.state === 'preparing' ? 'Hazırlanma aşaması' :
    state.state === 'seeking' ? 'Arama aşaması' : '';
  timerDiv.innerText = state.timeLeft ? `Süre: ${state.timeLeft}s` : '';
  scoresDiv.innerText = Object.entries(state.scores)
    .map(([id, sc]) => `Oyuncu ${id.slice(0,4)}: ${sc}`).join(' | ');

  if (me) {
    myColor = me.color;
    frozen = me.frozen;
    btnStart.style.display = (me.role === 'seeker' && state.state === 'lobby') ? 'inline-block' : 'none';
    if (me.role === 'hider' && state.state === 'preparing') {
      hiderButtons.style.display = 'flex';
      seekerButtons.style.display = 'none';
      document.getElementById('btn-pipette').disabled = frozen;
      document.getElementById('btn-freeze').disabled = frozen;
    } else if (me.role === 'seeker' && state.state === 'seeking') {
      hiderButtons.style.display = 'none';
      seekerButtons.style.display = 'flex';
    } else {
      hiderButtons.style.display = 'none';
      seekerButtons.style.display = 'none';
    }
  }
  // Uzak oyuncular
  const existingIds = new Set(Object.keys(remoteFigures));
  state.players.forEach(p => {
    if (p.id === myPlayerId) return;
    existingIds.delete(p.id);
    if (!remoteFigures[p.id]) {
      const geo = new THREE.CapsuleGeometry(0.5, 0.8, 2, 8);
      const mat = new THREE.MeshStandardMaterial({ color: p.color });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(p.x, 0.9, p.z);
      scene.add(mesh);
      remoteFigures[p.id] = mesh;
    } else {
      const mesh = remoteFigures[p.id];
      mesh.position.set(p.x, 0.9, p.z);
      mesh.material.color.set(p.color);
    }
  });
  existingIds.forEach(id => {
    scene.remove(remoteFigures[id]);
    delete remoteFigures[id];
  });
}

function handlePhaseChange(msg) {
  if (!gameState) return;
  gameState.state = msg.phase;
  updateGameState(gameState);
}

function exitToMenu() {
  gameUI.style.display = 'none';
  menuDiv.style.display = 'flex';
  if (gameInterval) clearInterval(gameInterval);
  if (scene && renderer) {
    renderer.dispose();
    document.body.removeChild(renderer.domElement);
  }
  scene = null;
  currentRoom = null;
  myPlayerId = null;
}

// ---------- Minecraft Blok Oluşturucu (%50 büyütülmüş) ----------
function createBlock(color, x, y, z, w = 1, h = 1, d = 1) {
  // %50 büyütme
  w *= 1.5; h *= 1.5; d *= 1.5;
  const geometry = new THREE.BoxGeometry(w, h, d);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  const block = new THREE.Mesh(geometry, material);
  block.position.set(x, y + h/2, z); // y pozisyonu taban yüksekliği olacak, ama biz parametre olarak taban y'yi vereceğiz
  block.castShadow = true;
  block.receiveShadow = true;
  block.userData = { color };
  // Çarpışma kutusu (AABB)
  const halfW = w/2, halfH = h/2, halfD = d/2;
  collisionBoxes.push({
    min: new THREE.Vector3(x - halfW, y, z - halfD),
    max: new THREE.Vector3(x + halfW, y + h, z + halfD)
  });
  return block;
}

// Yardımcı: blok dizisi ekleme
function addBlocks(blocksArray) {
  blocksArray.forEach(b => {
    const block = createBlock(b.color, b.x, b.y, b.z, b.w || 1, b.h || 1, b.d || 1);
    scene.add(block);
    mapObjects.push(block);
  });
}

// ---------- Sahne Kurulumu ----------
function initScene(mapType) {
  if (scene) {
    clearInterval(gameInterval);
    while (scene.children.length > 0) scene.remove(scene.children[0]);
    renderer.dispose();
    document.body.removeChild(renderer.domElement);
  }
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.Fog(0x87CEEB, 25, 60);
  camera = new THREE.PerspectiveCamera(55, window.innerWidth/window.innerHeight, 0.1, 150);
  camera.position.set(0, CAMERA_HEIGHT, CAMERA_DISTANCE);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  const ambient = new THREE.AmbientLight(0x8B9DC3);
  scene.add(ambient);
  const dirLight = new THREE.DirectionalLight(0xffeedd, 1.2);
  dirLight.position.set(20, 40, 15);
  dirLight.castShadow = true;
  dirLight.receiveShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  scene.add(dirLight);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(50, 50),
    new THREE.MeshStandardMaterial({ color: 0x7C9D4D })
  );
  ground.rotation.x = -Math.PI/2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  scene.add(ground);

  // Çarpışma listesini temizle
  collisionBoxes.length = 0;
  mapObjects = [];

  if (mapType === 'minecraft') {
    // --- Gerçek Minecraft benzeri yapılar (rastgele değil) ---
    const wood = 0x8B6B4D;
    const leaves = 0x2D5A27;
    const stone = 0x808080;
    const dirt = 0x8B6B4D;
    const brick = 0xB53C1A;
    const gold = 0xF7D44A;
    const water = 0x3399FF;

    // 1. Merkezi ev
    // Zemin (taş döşeme)
    for (let ix = -3; ix <= 3; ix++) {
      for (let iz = -3; iz <= 3; iz++) {
        addBlocks([{ color: stone, x: ix * 1.5, y: 0, z: iz * 1.5, w: 1, h: 0.5, d: 1 }]);
      }
    }
    // Duvarlar (ahşap)
    // Kuzey duvarı (z = -4.5)
    for (let ix = -3; ix <= 3; ix++) {
      addBlocks([{ color: wood, x: ix * 1.5, y: 0.5, z: -4.5, w: 1, h: 3, d: 1 }]);
    }
    // Güney duvarı (z = 4.5)
    for (let ix = -3; ix <= 3; ix++) {
      addBlocks([{ color: wood, x: ix * 1.5, y: 0.5, z: 4.5, w: 1, h: 3, d: 1 }]);
    }
    // Batı duvarı (x = -4.5)
    for (let iz = -3; iz <= 3; iz++) {
      addBlocks([{ color: wood, x: -4.5, y: 0.5, z: iz * 1.5, w: 1, h: 3, d: 1 }]);
    }
    // Doğu duvarı (x = 4.5)
    for (let iz = -3; iz <= 3; iz++) {
      addBlocks([{ color: wood, x: 4.5, y: 0.5, z: iz * 1.5, w: 1, h: 3, d: 1 }]);
    }
    // Kapı boşluğu (güney duvarının ortasındaki 2 bloğu kaldır) – elle kaldırmak yerine eklemeyelim, zaten ekledik, sonradan çarpışma kutusunu kaldırmak zor. Kolaylık: duvarı eksik ekleyelim.
    // Yukarıdaki döngüde ix = -1 ve 0'ı atlayalım güney duvarında. (Tekrar yazalım)
    // Basit olsun: tüm duvarları sonra ekleyelim, güney duvarını ortadan iki blok çıkaralım.
    // Yukarıdaki duvar kodlarını siliyorum, alttaki gibi yapıyorum:
    // Tüm duvarları sıfırdan ekleyelim.
    // (Yukarıdaki kodları kaldırıp aşağıya yeniden yazdım)
    // Ama zaten kod uzun, düzgün yapalım. Aşağıda tüm yapılandırmayı vereceğim.

    // Yeniden başlat: collisionBoxes temizlendi, ama zemin blokları zaten eklendi. Onları kaldırmak için mapObjects ve collisionBoxes'ı sıfırlayıp yeniden kuracağız.
    // Daha temiz: tüm yapıyı bir fonksiyonla kuralım.
    // Şu an initScene içinde bu bloğu tekrar yazacağım.

    // Önce collisionBoxes ve mapObjects'i temizleyip, zemin dahil yeniden oluşturacağım.
    while (mapObjects.length) {
      scene.remove(mapObjects.pop());
    }
    collisionBoxes.length = 0;

    // Şimdi yapıyı kur
    const blocksToAdd = [];

    // Zemin (taş zemin)
    for (let ix = -4; ix <= 4; ix++) {
      for (let iz = -4; iz <= 4; iz++) {
        blocksToAdd.push({ color: stone, x: ix * 1.5, y: 0, z: iz * 1.5, w: 1, h: 0.3, d: 1 });
      }
    }

    // Duvar yardımcıları
    const addWall = (start, end, axis, fixed, color = wood) => {
      if (axis === 'x') {
        for (let x = start; x <= end; x++) {
          blocksToAdd.push({ color, x: x * 1.5, y: 0.5, z: fixed, w: 1, h: 3, d: 1 });
        }
      } else if (axis === 'z') {
        for (let z = start; z <= end; z++) {
          blocksToAdd.push({ color, x: fixed, y: 0.5, z: z * 1.5, w: 1, h: 3, d: 1 });
        }
      }
    };

    // Kuzey duvarı (z = -4.5)
    addWall(-4, 4, 'x', -4.5, wood);
    // Güney duvarı (z = 4.5) – orta iki blok boş
    for (let x = -4; x <= 4; x++) {
      if (x >= -1 && x <= 0) continue; // kapı boşluğu
      blocksToAdd.push({ color: wood, x: x * 1.5, y: 0.5, z: 4.5, w: 1, h: 3, d: 1 });
    }
    // Batı duvarı (x = -4.5)
    addWall(-4, 4, 'z', -4.5, wood);
    // Doğu duvarı (x = 4.5)
    addWall(-4, 4, 'z', 4.5, wood);

    // Çatı (düz üst taş blok)
    for (let ix = -4; ix <= 4; ix++) {
      for (let iz = -4; iz <= 4; iz++) {
        blocksToAdd.push({ color: brick, x: ix * 1.5, y: 3.5, z: iz * 1.5, w: 1, h: 0.5, d: 1 });
      }
    }

    // İçeride masa (merkezde)
    blocksToAdd.push({ color: 0xFFFFFF, x: 0, y: 0.3, z: 0, w: 2, h: 0.5, d: 2 });
    blocksToAdd.push({ color: 0xFFFFFF, x: 0, y: 0.3 + 0.5, z: 1, w: 0.5, h: 1, d: 0.5 }); // sandalye

    // Ağaçlar (ev dışında)
    const tree = (tx, tz) => {
      // gövde
      blocksToAdd.push({ color: wood, x: tx, y: 0, z: tz, w: 0.8, h: 4, d: 0.8 });
      // yapraklar (üstte çapraz)
      blocksToAdd.push({ color: leaves, x: tx, y: 4, z: tz, w: 2.5, h: 2, d: 2.5 });
      blocksToAdd.push({ color: leaves, x: tx + 1.2, y: 3.5, z: tz, w: 1.5, h: 1.5, d: 1.5 });
      blocksToAdd.push({ color: leaves, x: tx - 1.2, y: 3.5, z: tz, w: 1.5, h: 1.5, d: 1.5 });
      blocksToAdd.push({ color: leaves, x: tx, y: 3.5, z: tz + 1.2, w: 1.5, h: 1.5, d: 1.5 });
      blocksToAdd.push({ color: leaves, x: tx, y: 3.5, z: tz - 1.2, w: 1.5, h: 1.5, d: 1.5 });
    };
    tree(-6, -6);
    tree(6, -6);
    tree(-6, 6);
    tree(6, 6);

    // Küçük gölet (su)
    for (let ix = 6; ix <= 7; ix++) {
      for (let iz = 6; iz <= 7; iz++) {
        blocksToAdd.push({ color: water, x: ix * 1.5, y: 0, z: iz * 1.5, w: 1, h: 0.4, d: 1 });
      }
    }

    // Tüm blokları ekle
    addBlocks(blocksToAdd);

  } else if (mapType === 'ev') {
    // Ev haritası (basit tutalım)
    const evBlocks = [
      { color: 0x8B0000, x: 1.5, y: 0, z: 2, w: 0.8, h: 1.2, d: 0.8 },
      { color: 0x5C4033, x: -2.5, y: 0, z: 1, w: 1.5, h: 0.4, d: 2 },
      { color: 0x708090, x: 2, y: 0, z: -2, w: 0.6, h: 2, d: 0.6 }, // silindir yerine kutu
      { color: 0xFF69B4, x: -2, y: 0, z: -2.5, w: 1, h: 1, d: 1 },
      { color: 0x556B2F, x: 3, y: 0, z: 3, w: 1.5, h: 0.8, d: 0.8 }
    ];
    addBlocks(evBlocks);
  }

  // Oyuncu figürü
  myFigure = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.5, 0.8, 2, 8),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  myFigure.castShadow = true;
  myFigure.receiveShadow = true;
  myFigure.position.y = 0.9;
  scene.add(myFigure);
  remoteFigures = {};

  // Döngü başlat
  if (gameInterval) clearInterval(gameInterval);
  gameInterval = setInterval(fixedUpdate, FIXED_FRAME_MS);
}

// ---------- Çarpışma kontrolü ----------
function resolveCollisions(pos) {
  const playerRadius = 0.4;
  for (const box of collisionBoxes) {
    // En yakın nokta
    const closest = new THREE.Vector3(
      Math.max(box.min.x, Math.min(pos.x, box.max.x)),
      Math.max(box.min.y, Math.min(pos.y, box.max.y)),
      Math.max(box.min.z, Math.min(pos.z, box.max.z))
    );
    const dist = pos.distanceTo(closest);
    if (dist < playerRadius) {
      const direction = pos.clone().sub(closest).normalize();
      pos.copy(closest.clone().add(direction.multiplyScalar(playerRadius)));
    }
  }
}

// ---------- Hareket (kamera yönünde) ----------
const keyState = { w: false, a: false, s: false, d: false };
window.addEventListener('keydown', e => {
  switch (e.key.toLowerCase()) {
    case 'w': keyState.w = true; e.preventDefault(); break;
    case 'a': keyState.a = true; e.preventDefault(); break;
    case 's': keyState.s = true; e.preventDefault(); break;
    case 'd': keyState.d = true; e.preventDefault(); break;
  }
});
window.addEventListener('keyup', e => {
  switch (e.key.toLowerCase()) {
    case 'w': keyState.w = false; e.preventDefault(); break;
    case 'a': keyState.a = false; e.preventDefault(); break;
    case 's': keyState.s = false; e.preventDefault(); break;
    case 'd': keyState.d = false; e.preventDefault(); break;
  }
});

// Joystick (sol)
const jBase = document.getElementById('joystick-base');
const jThumb = document.getElementById('joystick-thumb');
let joystickVec = { x: 0, z: 0 };

jBase.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (joystickTouchId === null) {
    const touch = e.changedTouches[0];
    joystickTouchId = touch.identifier;
  }
});
jBase.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) {
    const touch = e.changedTouches[i];
    if (touch.identifier === joystickTouchId) {
      const rect = jBase.getBoundingClientRect();
      const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
      let dx = touch.clientX - cx, dy = touch.clientY - cy;
      const maxR = 40, dist = Math.sqrt(dx*dx + dy*dy);
      if (dist > maxR) { dx *= maxR/dist; dy *= maxR/dist; }
      jThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      joystickVec.x = dx / maxR;
      joystickVec.z = dy / maxR; // yukarı = negatif z
      break;
    }
  }
});
jBase.addEventListener('touchend', (e) => {
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) {
    if (e.changedTouches[i].identifier === joystickTouchId) {
      joystickTouchId = null;
      jThumb.style.transform = 'translate(-50%, -50%)';
      joystickVec.x = 0;
      joystickVec.z = 0;
      break;
    }
  }
});

// Kamera sürükleme (sağ taraf)
const cameraDragZone = document.createElement('div');
cameraDragZone.style.cssText = 'position:absolute; top:0; right:0; width:40%; height:100%; z-index:5; touch-action:none;';
document.body.appendChild(cameraDragZone);

cameraDragZone.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (cameraTouchId === null) {
    const touch = e.changedTouches[0];
    cameraTouchId = touch.identifier;
    cameraTouchStartX = touch.clientX;
  }
});
cameraDragZone.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) {
    const touch = e.changedTouches[i];
    if (touch.identifier === cameraTouchId) {
      const dx = touch.clientX - cameraTouchStartX;
      cameraAngle -= dx * 0.01;
      cameraTouchStartX = touch.clientX;
      break;
    }
  }
});
cameraDragZone.addEventListener('touchend', (e) => {
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) {
    if (e.changedTouches[i].identifier === cameraTouchId) {
      cameraTouchId = null;
      break;
    }
  }
});

// Klavye kamera döndürme
window.addEventListener('keydown', (e) => {
  if (e.key === 'q' || e.key === 'Q') cameraAngle += 0.05;
  if (e.key === 'e' || e.key === 'E') cameraAngle -= 0.05;
});

const MOVE_SPEED = 0.15;

function handleMovement() {
  if (!myFigure || !ws || ws.readyState !== WebSocket.OPEN) return;

  // Klavye girişi
  let inputX = 0, inputZ = 0;
  if (keyState.w) inputZ -= 1;
  if (keyState.s) inputZ += 1;
  if (keyState.a) inputX -= 1;
  if (keyState.d) inputX += 1;
  // Joystick ekle
  inputX += joystickVec.x;
  inputZ += joystickVec.z; // joystick yukarı negatif z

  if (inputX !== 0 || inputZ !== 0) {
    // Yön vektörünü normalize et
    const len = Math.sqrt(inputX*inputX + inputZ*inputZ);
    inputX /= len;
    inputZ /= len;

    // Kamera yönüne göre dünya vektörü
    const forward = new THREE.Vector3(Math.sin(cameraAngle), 0, Math.cos(cameraAngle));
    const right = new THREE.Vector3(Math.cos(cameraAngle), 0, -Math.sin(cameraAngle));
    const moveDir = right.clone().multiplyScalar(inputX).add(forward.clone().multiplyScalar(-inputZ));
    moveDir.normalize();

    // Yeni pozisyon
    const newPos = myFigure.position.clone().add(moveDir.multiplyScalar(MOVE_SPEED));
    newPos.x = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, newPos.x));
    newPos.z = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, newPos.z));

    // Çarpışma çöz
    resolveCollisions(newPos);

    myFigure.position.copy(newPos);
    ws.send(JSON.stringify({ type: 'move', x: myFigure.position.x, z: myFigure.position.z }));
  }
}

// ---------- Sabit güncelleme ----------
function fixedUpdate() {
  handleMovement();
  // Kamera takip
  if (camera && myFigure) {
    const target = myFigure.position.clone();
    const offsetX = Math.sin(cameraAngle) * CAMERA_DISTANCE;
    const offsetZ = Math.cos(cameraAngle) * CAMERA_DISTANCE;
    const desiredPos = new THREE.Vector3(target.x + offsetX, target.y + CAMERA_HEIGHT, target.z + offsetZ);
    camera.position.lerp(desiredPos, 0.15);
    camera.lookAt(target.x, target.y + 0.5, target.z);
  }
  if (renderer && scene && camera) renderer.render(scene, camera);
}

// ---------- Butonlar ----------
document.getElementById('btn-pipette').onclick = () => {
  if (!myFigure || frozen) return;
  const pos = myFigure.position;
  let closestDist = 2.5;
  let picked = null;
  mapObjects.forEach(obj => {
    const d = pos.distanceTo(obj.position);
    if (d < closestDist) { closestDist = d; picked = obj.userData.color; }
  });
  if (picked !== null) {
    myColor = picked;
    myFigure.material.color.set(picked);
    ws.send(JSON.stringify({ type: 'color', color: picked }));
  }
};
document.getElementById('btn-freeze').onclick = () => {
  if (frozen) return;
  ws.send(JSON.stringify({ type: 'freeze' }));
};
document.getElementById('btn-catch').onclick = () => {
  ws.send(JSON.stringify({ type: 'catch' }));
};

window.addEventListener('resize', () => {
  if (camera) {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
});