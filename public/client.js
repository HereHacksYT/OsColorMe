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

// Oda listesi (arama için)
let currentRoomList = [];

// Sabit güncelleme aralığı (30 FPS)
const FIXED_FRAME_MS = 1000 / 30;
let gameInterval = null;

// --- Kamera kontrol değişkenleri ---
let cameraAngle = 0; // yatay açı (radyan)
const CAMERA_DISTANCE = 10; // kamera mesafesi
const CAMERA_HEIGHT = 6;    // yükseklik
// Mobil kamera sürükleme
let isDraggingCamera = false;
let lastTouchX = 0;

// --- Harita sınırı (genişletildi) ---
const WORLD_LIMIT = 18; // ±18 birim

// ---------- Bağlantı ----------
function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => console.log('Connected');
  ws.onmessage = handleServerMessage;
  ws.onclose = () => setTimeout(connect, 2000);
}
connect();

// ---------- Menü / Form Olayları ----------
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

// Oda arama
const joinNameInput = document.getElementById('join-room-name');
joinNameInput.addEventListener('input', () => {
  updateJoinSearchResults(joinNameInput.value.trim().toLowerCase());
});

function updateJoinSearchResults(query) {
  const resultsDiv = document.getElementById('search-results');
  const filtered = currentRoomList.filter(r =>
    r.name.toLowerCase().includes(query)
  );
  resultsDiv.innerHTML = filtered.map(r => `
    <div style="padding:6px; cursor:pointer; border-bottom:1px solid #555;"
         onclick="selectRoom('${r.name}', ${r.hasPassword})">
      ${r.name} (${r.players}/${r.maxPlayers}) - ${r.map} ${r.hasPassword ? '🔒' : ''}
    </div>
  `).join('');
}

window.selectRoom = (roomName, hasPassword) => {
  document.getElementById('join-room-name').value = roomName;
  const passField = document.getElementById('join-password');
  passField.style.display = hasPassword ? 'block' : 'none';
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
                  document.getElementById('join-password').style.display='${r.hasPassword ? 'block' : 'none'}';">
      ${r.name} (${r.players}/${r.maxPlayers}) - ${r.map} ${r.hasPassword ? '🔒' : ''}
    </div>
  `).join('');
}

// ---------- Sunucu Mesajları ----------
function handleServerMessage(event) {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'roomList':
      updateRoomList(msg.rooms);
      break;
    case 'roomCreated':
    case 'roomJoined':
      currentRoom = msg.roomId;
      createForm.style.display = 'none';
      joinForm.style.display = 'none';
      menuDiv.style.display = 'none';
      break;
    case 'roomState':
      updateGameState(msg);
      break;
    case 'phase':
      handlePhaseChange(msg);
      break;
    case 'roundEnd':
      alert(msg.caught ? 'Yakalandınız!' : 'Kurtuldunuz!');
      break;
    case 'catchFail':
      alert(msg.message);
      break;
    case 'error':
      alert(msg.message);
      break;
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
    .map(([id, sc]) => `Oyuncu ${id.slice(0, 4)}: ${sc}`)
    .join(' | ');

  if (me) {
    // Renk ve donma durumu sunucudan alınır, pozisyonu değiştirme
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

  // Uzak oyuncuları güncelle
  const existingIds = new Set(Object.keys(remoteFigures));
  state.players.forEach(p => {
    if (p.id === myPlayerId) return;
    existingIds.delete(p.id);
    if (!remoteFigures[p.id]) {
      const geo = new THREE.CapsuleGeometry(0.4, 0.6, 2, 8);
      const mat = new THREE.MeshStandardMaterial({ color: p.color });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(p.x, 0.7, p.z);
      scene.add(mesh);
      remoteFigures[p.id] = mesh;
    } else {
      const mesh = remoteFigures[p.id];
      mesh.position.set(p.x, 0.7, p.z);
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

// ---------- Three.js Sahne (GERÇEK MINECRAFT TARZI BLOKLAR) ----------
function createMinecraftBlock(color, x, y, z, sx = 1, sy = 1, sz = 1) {
  // Kenarları belirgin, piksel görünümlü bloklar için hafif koyu kenarlıklı malzeme kullanıyoruz
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.1 });
  const block = new THREE.Mesh(geometry, material);
  block.position.set(x, y, z);
  block.castShadow = true;
  block.receiveShadow = true;
  block.userData = { color };
  
  // İsteğe bağlı: wireframe ekleyerek piksel havası verelim (hafif)
  // const edges = new THREE.EdgesGeometry(geometry);
  // const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x000000 }));
  // block.add(line);
  
  return block;
}

function initScene(mapType) {
  if (scene) {
    clearInterval(gameInterval);
    while (scene.children.length > 0) scene.remove(scene.children[0]);
    renderer.dispose();
    document.body.removeChild(renderer.domElement);
  }
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.Fog(0x87CEEB, 20, 50);
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, CAMERA_HEIGHT + 4, CAMERA_DISTANCE);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  const ambient = new THREE.AmbientLight(0x8B9DC3);
  scene.add(ambient);
  const dirLight = new THREE.DirectionalLight(0xffeedd, 1);
  dirLight.position.set(15, 30, 10);
  dirLight.castShadow = true;
  dirLight.receiveShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 1;
  dirLight.shadow.camera.far = 80;
  dirLight.shadow.camera.left = -25;
  dirLight.shadow.camera.right = 25;
  dirLight.shadow.camera.top = 25;
  dirLight.shadow.camera.bottom = -25;
  scene.add(dirLight);

  // Zemin (çimen yeşili)
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x7C9D4D })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  scene.add(ground);

  mapObjects = [];

  if (mapType === 'minecraft') {
    // --- Minecraft tarzı blok dünyası ---
    // Çeşitli blok renkleri (MC paleti)
    const grass = 0x7C9D4D;
    const dirt = 0x8B6B4D;
    const stone = 0x808080;
    const wood = 0x8B6B4D;
    const leaves = 0x2D5A27;
    const brick = 0xB53C1A;
    const obsidian = 0x1A1A2E;
    const gold = 0xF7D44A;
    const ice = 0x90CAF9;
    const sand = 0xE0D8A0;
    
    // Geniş zemin üzerinde rastgele blok kümeleri
    // Orta alanda bir "bina" ya da yapı
    for (let ix = -3; ix <= 3; ix++) {
      for (let iz = -3; iz <= 3; iz++) {
        const rand = Math.random();
        let color = dirt;
        if (rand < 0.3) color = stone;
        else if (rand < 0.5) color = dirt;
        else if (rand < 0.7) color = wood;
        else if (rand < 0.85) color = brick;
        else color = obsidian;
        
        const block = createMinecraftBlock(color, ix * 1.2, 0.6, iz * 1.2, 1, 1.2, 1);
        scene.add(block);
        mapObjects.push(block);
        
        // Bazen ikinci kat
        if (Math.random() < 0.3) {
          const topBlock = createMinecraftBlock(color, ix * 1.2, 1.8, iz * 1.2, 1, 1.2, 1);
          scene.add(topBlock);
          mapObjects.push(topBlock);
        }
      }
    }
    
    // Etrafa dağılmış büyük bloklar
    const extraBlocks = [
      { c: grass, x: 5, y: 0.6, z: 5, sx: 2, sy: 1.5, sz: 2 },
      { c: stone, x: -5, y: 1.0, z: 4, sx: 1.5, sy: 2, sz: 1.5 },
      { c: wood, x: 6, y: 0.5, z: -3, sx: 1, sy: 2, sz: 1 },
      { c: leaves, x: 6, y: 2.5, z: -3, sx: 1.2, sy: 1, sz: 1.2 },
      { c: gold, x: -4, y: 0.7, z: -5, sx: 1, sy: 1, sz: 1 },
      { c: ice, x: 0, y: 0.5, z: 6, sx: 2, sy: 0.8, sz: 2 },
      { c: sand, x: -6, y: 0.5, z: -2, sx: 1.5, sy: 1, sz: 1.5 },
      { c: obsidian, x: 3, y: 1, z: -6, sx: 1, sy: 2, sz: 1 },
    ];
    extraBlocks.forEach(b => {
      const block = createMinecraftBlock(b.c, b.x, b.y, b.z, b.sx, b.sy, b.sz);
      scene.add(block);
      mapObjects.push(block);
    });
    
    // Birkaç "ağaç" (gövde + yaprak)
    const treePositions = [[7, 5], [-7, -4], [4, -7], [-5, 7]];
    treePositions.forEach(([tx, tz]) => {
      // gövde
      const trunk = createMinecraftBlock(wood, tx, 0.8, tz, 0.8, 2.5, 0.8);
      scene.add(trunk);
      mapObjects.push(trunk);
      // yapraklar
      const leaf = createMinecraftBlock(leaves, tx, 3.2, tz, 1.5, 1.5, 1.5);
      scene.add(leaf);
      mapObjects.push(leaf);
      const leaf2 = createMinecraftBlock(leaves, tx + 0.8, 2.8, tz, 1.2, 1.2, 1.2);
      scene.add(leaf2);
      mapObjects.push(leaf2);
      const leaf3 = createMinecraftBlock(leaves, tx - 0.8, 2.8, tz, 1.2, 1.2, 1.2);
      scene.add(leaf3);
      mapObjects.push(leaf3);
    });
  } else if (mapType === 'ev') {
    // Ev haritası aynen devam (azıcık genişletelim)
    const evBlocks = [
      { type: 'box', size: [0.8, 1.2, 0.8], pos: [1.5, 0.6, 2], color: 0x8B0000 },
      { type: 'box', size: [1.5, 0.4, 2], pos: [-2.5, 0.2, 1], color: 0x5C4033 },
      { type: 'cylinder', radiusTop: 0.4, radiusBottom: 0.4, height: 2, pos: [2, 1, -2], color: 0x708090 },
      { type: 'sphere', radius: 0.7, pos: [-2, 0.7, -2.5], color: 0xFF69B4 },
      { type: 'box', size: [1.5, 0.8, 0.8], pos: [3, 0.4, 3], color: 0x556B2F }
    ];
    evBlocks.forEach(obj => {
      let mesh;
      if (obj.type === 'box') mesh = new THREE.Mesh(new THREE.BoxGeometry(...obj.size), new THREE.MeshStandardMaterial({ color: obj.color }));
      else if (obj.type === 'sphere') mesh = new THREE.Mesh(new THREE.SphereGeometry(obj.radius), new THREE.MeshStandardMaterial({ color: obj.color }));
      else if (obj.type === 'cylinder') mesh = new THREE.Mesh(new THREE.CylinderGeometry(obj.radiusTop, obj.radiusBottom, obj.height), new THREE.MeshStandardMaterial({ color: obj.color }));
      mesh.position.set(obj.pos[0], obj.pos[1], obj.pos[2]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { color: obj.color };
      scene.add(mesh);
      mapObjects.push(mesh);
    });
  }

  myFigure = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.5, 0.8, 2, 8),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  myFigure.castShadow = true;
  myFigure.receiveShadow = true;
  myFigure.position.y = 0.9;
  scene.add(myFigure);
  remoteFigures = {};

  if (gameInterval) clearInterval(gameInterval);
  gameInterval = setInterval(fixedUpdate, FIXED_FRAME_MS);
}

// --- KAMERA SÜRÜKLEME ---
const cameraDragZone = document.createElement('div');
cameraDragZone.style.cssText = 'position:absolute; top:0; right:0; width:40%; height:100%; z-index:5; touch-action:none;';
document.body.appendChild(cameraDragZone);

cameraDragZone.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    isDraggingCamera = true;
    lastTouchX = e.touches[0].clientX;
  }
});

cameraDragZone.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!isDraggingCamera || e.touches.length !== 1) return;
  const dx = e.touches[0].clientX - lastTouchX;
  cameraAngle -= dx * 0.01; // hassasiyet
  lastTouchX = e.touches[0].clientX;
});

cameraDragZone.addEventListener('touchend', (e) => {
  e.preventDefault();
  isDraggingCamera = false;
});

// PC klavye ile Q/E tuşları
window.addEventListener('keydown', (e) => {
  if (e.key === 'q' || e.key === 'Q') {
    cameraAngle += 0.05;
  } else if (e.key === 'e' || e.key === 'E') {
    cameraAngle -= 0.05;
  }
});

function fixedUpdate() {
  handleMovement();
  updateCameraPosition();
  if (renderer && scene && camera) renderer.render(scene, camera);
}

function updateCameraPosition() {
  if (!myFigure) return;
  const target = myFigure.position.clone();
  const offsetX = Math.sin(cameraAngle) * CAMERA_DISTANCE;
  const offsetZ = Math.cos(cameraAngle) * CAMERA_DISTANCE;
  const desiredPosition = new THREE.Vector3(
    target.x + offsetX,
    target.y + CAMERA_HEIGHT,
    target.z + offsetZ
  );
  camera.position.lerp(desiredPosition, 0.15);
  camera.lookAt(target.x, target.y + 0.5, target.z);
}

// ---------- Hareket ----------
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
let jActive = false, jVec = { x: 0, z: 0 };
jBase.addEventListener('touchstart', e => { e.preventDefault(); jActive = true; });
jBase.addEventListener('touchmove', e => {
  e.preventDefault();
  if (!jActive) return;
  const touch = e.touches[0];
  const rect = jBase.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  let dx = touch.clientX - cx, dy = touch.clientY - cy;
  const maxR = 40, dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > maxR) { dx *= maxR / dist; dy *= maxR / dist; }
  jThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  jVec.x = dx / maxR;
  jVec.z = dy / maxR;
});
jBase.addEventListener('touchend', e => {
  e.preventDefault(); jActive = false;
  jThumb.style.transform = 'translate(-50%, -50%)';
  jVec.x = 0; jVec.z = 0;
});

const MOVE_SPEED = 0.15;

function handleMovement() {
  if (!myFigure || !ws || ws.readyState !== WebSocket.OPEN) return;
  let dx = 0, dz = 0;
  if (keyState.w) dz -= 1;
  if (keyState.s) dz += 1;
  if (keyState.a) dx -= 1;
  if (keyState.d) dx += 1;
  dx += jVec.x;
  dz += jVec.z;
  if (dx !== 0 || dz !== 0) {
    const len = Math.sqrt(dx * dx + dz * dz);
    dx /= len; dz /= len;
    myFigure.position.x += dx * MOVE_SPEED;
    myFigure.position.z += dz * MOVE_SPEED;
    // Genişletilmiş sınırlar
    myFigure.position.x = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, myFigure.position.x));
    myFigure.position.z = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, myFigure.position.z));
    ws.send(JSON.stringify({
      type: 'move',
      x: myFigure.position.x,
      z: myFigure.position.z
    }));
  }
}

// ---------- Buton işlevleri ----------
document.getElementById('btn-pipette').onclick = () => {
  if (!myFigure || frozen) return;
  const pos = myFigure.position;
  let closestDist = 2.2;
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