import * as THREE from 'three';

// ---------- Bağlantı ----------
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${protocol}://${location.host}`;
let ws;
let myPlayerId = null;
let currentRoom = null;
let gameState = null;

// UI elemanları
let menuDiv, createForm, joinForm, gameUI;
let statusText, timerDiv, scoresDiv, btnStart;
let hiderButtons, seekerButtons;

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
let cameraAngle = 0;
const CAMERA_DISTANCE = 12;
const CAMERA_HEIGHT = 8;

// Çoklu dokunmatik kimlikleri
let joystickTouchId = null;
let cameraTouchId = null;
let cameraTouchStartX = 0;

// --- Harita & Çarpışma ---
const WORLD_LIMIT = 20;
let collisionBoxes = [];

// Sayfa tamamen yüklendikten sonra tüm referansları al ve event'leri bağla
window.addEventListener('DOMContentLoaded', () => {
  menuDiv = document.getElementById('menu');
  createForm = document.getElementById('create-form');
  joinForm = document.getElementById('join-form');
  gameUI = document.getElementById('game-ui');
  statusText = document.getElementById('status-text');
  timerDiv = document.getElementById('timer');
  scoresDiv = document.getElementById('scores');
  btnStart = document.getElementById('btn-start');
  hiderButtons = document.getElementById('hider-buttons');
  seekerButtons = document.getElementById('seeker-buttons');

  // Buton olayları
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

  // WebSocket bağlantısını şimdi başlat (DOM hazır)
  connect();
});

// ---------- Bağlantı ----------
function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => console.log('Connected');
  ws.onmessage = handleServerMessage;
  ws.onclose = () => setTimeout(connect, 2000);
}

// Oda arama yardımcıları
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
  if (statusText) statusText.innerText =
    state.state === 'lobby' ? 'Lobide bekleniyor...' :
    state.state === 'preparing' ? 'Hazırlanma aşaması' :
    state.state === 'seeking' ? 'Arama aşaması' : '';
  if (timerDiv) timerDiv.innerText = state.timeLeft ? `Süre: ${state.timeLeft}s` : '';
  if (scoresDiv) scoresDiv.innerText = Object.entries(state.scores)
    .map(([id, sc]) => `Oyuncu ${id.slice(0,4)}: ${sc}`).join(' | ');

  if (me) {
    myColor = me.color;
    frozen = me.frozen;

    if (btnStart) btnStart.style.display = (me.role === 'seeker' && state.state === 'lobby') ? 'inline-block' : 'none';

    if (me.role === 'hider' && state.state === 'preparing') {
      if (hiderButtons) hiderButtons.style.display = 'flex';
      if (seekerButtons) seekerButtons.style.display = 'none';
      const pipetteBtn = document.getElementById('btn-pipette');
      const freezeBtn = document.getElementById('btn-freeze');
      if (pipetteBtn) pipetteBtn.disabled = frozen;
      if (freezeBtn) freezeBtn.disabled = frozen;
    } else if (me.role === 'seeker' && state.state === 'seeking') {
      if (hiderButtons) hiderButtons.style.display = 'none';
      if (seekerButtons) seekerButtons.style.display = 'flex';
    } else {
      if (hiderButtons) hiderButtons.style.display = 'none';
      if (seekerButtons) seekerButtons.style.display = 'none';
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
      mesh.castShadow = true; mesh.receiveShadow = true;
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

// ---------- Blok oluşturma (çarpışma kutulu) ----------
function createBlock(color, x, y, z, w = 1, h = 1, d = 1) {
  w *= 1.5; h *= 1.5; d *= 1.5;
  const geometry = new THREE.BoxGeometry(w, h, d);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  const block = new THREE.Mesh(geometry, material);
  block.position.set(x, y + h/2, z);
  block.castShadow = true;
  block.receiveShadow = true;
  block.userData = { color };
  const halfW = w/2, halfH = h/2, halfD = d/2;
  collisionBoxes.push({
    min: new THREE.Vector3(x - halfW, y, z - halfD),
    max: new THREE.Vector3(x + halfW, y + h, z + halfD)
  });
  return block;
}

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

  collisionBoxes = [];
  mapObjects = [];

  if (mapType === 'minecraft') {
    const wood = 0x8B6B4D, leaves = 0x2D5A27, stone = 0x808080;
    const brick = 0xB53C1A, water = 0x3399FF;

    for (let ix = -4; ix <= 4; ix++) {
      for (let iz = -4; iz <= 4; iz++) {
        addBlocks([{ color: stone, x: ix * 1.5, y: 0, z: iz * 1.5, w: 1, h: 0.3, d: 1 }]);
      }
    }

    const addWall = (start, end, axis, fixed, color = wood) => {
      for (let i = start; i <= end; i++) {
        if (axis === 'x') addBlocks([{ color, x: i * 1.5, y: 0.5, z: fixed, w: 1, h: 3, d: 1 }]);
        else addBlocks([{ color, x: fixed, y: 0.5, z: i * 1.5, w: 1, h: 3, d: 1 }]);
      }
    };
    addWall(-4, 4, 'x', -4.5, wood);
    for (let x = -4; x <= 4; x++) {
      if (x >= -1 && x <= 0) continue;
      addBlocks([{ color: wood, x: x * 1.5, y: 0.5, z: 4.5, w: 1, h: 3, d: 1 }]);
    }
    addWall(-4, 4, 'z', -4.5, wood);
    addWall(-4, 4, 'z', 4.5, wood);

    for (let ix = -4; ix <= 4; ix++)
      for (let iz = -4; iz <= 4; iz++)
        addBlocks([{ color: brick, x: ix * 1.5, y: 3.5, z: iz * 1.5, w: 1, h: 0.5, d: 1 }]);

    addBlocks([{ color: 0xFFFFFF, x: 0, y: 0.3, z: 0, w: 2, h: 0.5, d: 2 }]);
    addBlocks([{ color: 0xFFFFFF, x: 0, y: 0.8, z: 1, w: 0.5, h: 1, d: 0.5 }]);

    const tree = (tx, tz) => {
      addBlocks([{ color: wood, x: tx, y: 0, z: tz, w: 0.8, h: 4, d: 0.8 }]);
      addBlocks([{ color: leaves, x: tx, y: 4, z: tz, w: 2.5, h: 2, d: 2.5 }]);
      [[1.2,0],[-1.2,0],[0,1.2],[0,-1.2]].forEach(([dx,dz]) =>
        addBlocks([{ color: leaves, x: tx+dx, y: 3.5, z: tz+dz, w: 1.5, h: 1.5, d: 1.5 }])
      );
    };
    tree(-6, -6); tree(6, -6); tree(-6, 6); tree(6, 6);

    for (let ix = 6; ix <= 7; ix++)
      for (let iz = 6; iz <= 7; iz++)
        addBlocks([{ color: water, x: ix * 1.5, y: 0, z: iz * 1.5, w: 1, h: 0.4, d: 1 }]);
  } else if (mapType === 'ev') {
    const evBlocks = [
      { color: 0x8B0000, x: 1.5, y: 0, z: 2, w: 0.8, h: 1.2, d: 0.8 },
      { color: 0x5C4033, x: -2.5, y: 0, z: 1, w: 1.5, h: 0.4, d: 2 },
      { color: 0x708090, x: 2, y: 0, z: -2, w: 0.6, h: 2, d: 0.6 },
      { color: 0xFF69B4, x: -2, y: 0, z: -2.5, w: 1, h: 1, d: 1 },
      { color: 0x556B2F, x: 3, y: 0, z: 3, w: 1.5, h: 0.8, d: 0.8 }
    ];
    addBlocks(evBlocks);
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

// ---------- Çarpışma ----------
function resolveCollisions(pos) {
  const playerRadius = 0.4;
  for (const box of collisionBoxes) {
    const closest = new THREE.Vector3(
      Math.max(box.min.x, Math.min(pos.x, box.max.x)),
      Math.max(box.min.y, Math.min(pos.y, box.max.y)),
      Math.max(box.min.z, Math.min(pos.z, box.max.z))
    );
    const dist = pos.distanceTo(closest);
    if (dist < playerRadius) {
      const dir = pos.clone().sub(closest).normalize();
      pos.copy(closest.clone().add(dir.multiplyScalar(playerRadius)));
    }
  }
}

// ---------- Giriş & Joystick ----------
const keyState = { w:false, a:false, s:false, d:false };
window.addEventListener('keydown', e => {
  switch(e.key.toLowerCase()){
    case 'w': keyState.w=true; e.preventDefault(); break;
    case 'a': keyState.a=true; e.preventDefault(); break;
    case 's': keyState.s=true; e.preventDefault(); break;
    case 'd': keyState.d=true; e.preventDefault(); break;
  }
});
window.addEventListener('keyup', e => {
  switch(e.key.toLowerCase()){
    case 'w': keyState.w=false; e.preventDefault(); break;
    case 'a': keyState.a=false; e.preventDefault(); break;
    case 's': keyState.s=false; e.preventDefault(); break;
    case 'd': keyState.d=false; e.preventDefault(); break;
  }
});

const jBase = document.getElementById('joystick-base');
const jThumb = document.getElementById('joystick-thumb');
let joystickVec = { x:0, z:0 };

jBase.addEventListener('touchstart', e => {
  e.preventDefault();
  if (joystickTouchId === null) joystickTouchId = e.changedTouches[0].identifier;
});
jBase.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const touch of e.changedTouches) {
    if (touch.identifier === joystickTouchId) {
      const rect = jBase.getBoundingClientRect();
      const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
      let dx = touch.clientX - cx, dy = touch.clientY - cy;
      const maxR = 40, dist = Math.sqrt(dx*dx+dy*dy);
      if (dist > maxR) { dx *= maxR/dist; dy *= maxR/dist; }
      jThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      joystickVec.x = dx / maxR;
      joystickVec.z = dy / maxR;
      break;
    }
  }
});
jBase.addEventListener('touchend', e => {
  e.preventDefault();
  for (const touch of e.changedTouches) {
    if (touch.identifier === joystickTouchId) {
      joystickTouchId = null;
      jThumb.style.transform = 'translate(-50%, -50%)';
      joystickVec.x = 0; joystickVec.z = 0;
      break;
    }
  }
});

// Kamera sürükleme (çakışmayacak şekilde)
const cameraDragZone = document.createElement('div');
cameraDragZone.style.cssText = 'position:absolute; top:0; right:0; width:40%; height:70%; z-index:5; touch-action:none;';
document.body.appendChild(cameraDragZone);

cameraDragZone.addEventListener('touchstart', e => {
  e.preventDefault();
  if (cameraTouchId === null) {
    cameraTouchId = e.changedTouches[0].identifier;
    cameraTouchStartX = e.changedTouches[0].clientX;
  }
});
cameraDragZone.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const touch of e.changedTouches) {
    if (touch.identifier === cameraTouchId) {
      const dx = touch.clientX - cameraTouchStartX;
      cameraAngle -= dx * 0.01;
      cameraTouchStartX = touch.clientX;
      break;
    }
  }
});
cameraDragZone.addEventListener('touchend', e => {
  e.preventDefault();
  for (const touch of e.changedTouches) {
    if (touch.identifier === cameraTouchId) {
      cameraTouchId = null;
      break;
    }
  }
});

window.addEventListener('keydown', e => {
  if (e.key === 'q' || e.key === 'Q') cameraAngle += 0.05;
  if (e.key === 'e' || e.key === 'E') cameraAngle -= 0.05;
});

// ---------- Hareket (kamera yönüne göre) ----------
const MOVE_SPEED = 0.15;

function handleMovement() {
  if (!myFigure || !ws || ws.readyState !== WebSocket.OPEN) return;

  let inputX = 0, inputZ = 0;
  if (keyState.w) inputZ -= 1;
  if (keyState.s) inputZ += 1;
  if (keyState.a) inputX -= 1;
  if (keyState.d) inputX += 1;
  inputX += joystickVec.x;
  inputZ += joystickVec.z;

  if (inputX !== 0 || inputZ !== 0) {
    const len = Math.sqrt(inputX*inputX + inputZ*inputZ);
    inputX /= len; inputZ /= len;

    const forward = new THREE.Vector3(Math.sin(cameraAngle), 0, Math.cos(cameraAngle));
    const right = new THREE.Vector3(Math.cos(cameraAngle), 0, -Math.sin(cameraAngle));
    const moveDir = right.clone().multiplyScalar(inputX).add(forward.clone().multiplyScalar(-inputZ));
    moveDir.normalize();

    const newPos = myFigure.position.clone().add(moveDir.multiplyScalar(MOVE_SPEED));
    newPos.x = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, newPos.x));
    newPos.z = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, newPos.z));
    resolveCollisions(newPos);
    myFigure.position.copy(newPos);
    ws.send(JSON.stringify({ type: 'move', x: myFigure.position.x, z: myFigure.position.z }));
  }
}

function fixedUpdate() {
  handleMovement();
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

// Oyun içi butonlar (güvenli atama)
document.getElementById('btn-pipette')?.addEventListener('click', () => {
  if (!myFigure || frozen) return;
  const pos = myFigure.position;
  let closestDist = 2.5, picked = null;
  mapObjects.forEach(obj => {
    const d = pos.distanceTo(obj.position);
    if (d < closestDist) { closestDist = d; picked = obj.userData.color; }
  });
  if (picked !== null) {
    myColor = picked;
    myFigure.material.color.set(picked);
    ws.send(JSON.stringify({ type: 'color', color: picked }));
  }
});
document.getElementById('btn-freeze')?.addEventListener('click', () => {
  if (frozen) return;
  ws.send(JSON.stringify({ type: 'freeze' }));
});
document.getElementById('btn-catch')?.addEventListener('click', () => {
  ws.send(JSON.stringify({ type: 'catch' }));
});

window.addEventListener('resize', () => {
  if (camera) {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
});