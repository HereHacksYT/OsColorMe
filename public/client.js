import * as THREE from 'three';

// ======================== GLOBAL ========================
window.ws = null;
let myPlayerId = null, currentRoomId = null, gameState = null;
let menuDiv, createForm, joinForm, gameUI, statusText, timerDiv, scoresDiv, btnStart, hiderButtons, seekerButtons;
let scene, camera, renderer, mapObjects = [], myFigure, remoteFigures = {}, myColor = 0xffffff, frozen = false;
let currentRoomList = [], gameInterval = null;
let cameraAngle = Math.PI;
let CAMERA_DISTANCE = 5;
let CAMERA_HEIGHT = 3;
const CAMERA_MIN = 3, CAMERA_MAX = 20;
let joystickTouchId = null, cameraTouchId = null, cameraTouchStartX = 0;
let pinchStartDist = 0;
const WORLD_LIMIT = 36;
const FIXED_FRAME_MS = 1000 / 30;
let collisionBoxes = [];
let bullets = [];
let raycaster = new THREE.Raycaster();

// Boya sistemi
let paintMode = 'pipette'; // 'pipette' | 'brush'
let brushColor = 0xFFFFFF;
let brushParts = []; // boyanmış parçalar (vücut kısımları)

// ======================== MINECRAFT DOKU OLUŞTURUCU ========================
function createMinecraftTexture(baseColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  
  // Ana renk
  const r = (baseColor >> 16) & 0xff;
  const g = (baseColor >> 8) & 0xff;
  const b = baseColor & 0xff;
  
  // Piksel piksel doku
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 16; y++) {
      // Kenarlar koyu
      if (x === 0 || y === 0 || x === 15 || y === 15) {
        ctx.fillStyle = `rgb(${Math.floor(r*0.4)},${Math.floor(g*0.4)},${Math.floor(b*0.4)})`;
      }
      // İç kenarlar hafif koyu
      else if (x === 1 || y === 1 || x === 14 || y === 14) {
        ctx.fillStyle = `rgb(${Math.floor(r*0.6)},${Math.floor(g*0.6)},${Math.floor(b*0.6)})`;
      }
      // Orta kısım açık
      else if (x < 4 || x > 12 || y < 4 || y > 12) {
        ctx.fillStyle = `rgb(${Math.floor(r*0.8)},${Math.floor(g*0.8)},${Math.floor(b*0.8)})`;
      }
      // Merkez ana renk
      else {
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      }
      ctx.fillRect(x, y, 1, 1);
    }
  }
  
  // Rastgele piksel gürültüsü
  for (let i = 0; i < 20; i++) {
    const rx = Math.floor(Math.random() * 14) + 1;
    const ry = Math.floor(Math.random() * 14) + 1;
    const noise = Math.random() * 30 - 15;
    ctx.fillStyle = `rgb(${Math.min(255,Math.max(0,r+noise))},${Math.min(255,Math.max(0,g+noise))},${Math.min(255,Math.max(0,b+noise))})`;
    ctx.fillRect(rx, ry, 1, 1);
  }
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  return texture;
}

// ======================== BUTONLAR ========================
window.createRoom = () => {
  if (!window.ws || window.ws.readyState !== WebSocket.OPEN) return alert('Bağlantı yok');
  const name = document.getElementById('room-name').value.trim();
  if (!name) return alert('İsim girin');
  const map = document.getElementById('map-select').value;
  const hiderTime = +document.getElementById('hider-time').value;
  const seekerTime = +document.getElementById('seeker-time').value;
  const maxPlayers = +document.getElementById('max-players').value;
  const isPublic = document.querySelector('input[name="visibility"]:checked').value === 'public';
  const password = isPublic ? '' : document.getElementById('room-password').value;
  window.ws.send(JSON.stringify({ type: 'createRoom', settings: { name, map, hiderPrepTime: hiderTime, seekerTime, maxPlayers, public: isPublic, password } }));
};
window.joinRoom = () => {
  if (!window.ws || window.ws.readyState !== WebSocket.OPEN) return alert('Bağlantı yok');
  const roomName = document.getElementById('join-room-name').value.trim();
  if (!roomName) return;
  const password = document.getElementById('join-password').value;
  window.ws.send(JSON.stringify({ type: 'joinRoom', roomName, password }));
};
window.updateJoinSearchResults = (query) => {
  const resultsDiv = document.getElementById('search-results');
  if (!resultsDiv) return;
  const filtered = currentRoomList.filter(r => r.name.toLowerCase().includes(query));
  resultsDiv.innerHTML = filtered.map(r =>
    `<div style="padding:6px; cursor:pointer; border-bottom:1px solid #555;" 
          onclick="document.getElementById('join-room-name').value='${r.name}'; 
                   document.getElementById('join-password').style.display='${r.hasPassword?'block':'none'}'; 
                   document.getElementById('search-results').innerHTML='';">
       ${r.name} (${r.players}/${r.max}) - ${r.map} ${r.hasPassword?'🔒':''}
     </div>`
  ).join('');
};

// ======================== DOMContentLoaded ========================
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

  document.querySelectorAll('input[name="visibility"]').forEach(r => r.onchange = () => {
    document.getElementById('password-field').style.display = r.value === 'private' ? 'block' : 'none';
  });
  document.getElementById('btn-leave').onclick = () => { window.ws.send(JSON.stringify({ type: 'leaveRoom' })); exitToMenu(); };
  btnStart.onclick = () => window.ws.send(JSON.stringify({ type: 'startGame' }));
  document.getElementById('btn-pipette').onclick = toggleBrushMode;
  document.getElementById('btn-freeze').onclick = () => window.ws.send(JSON.stringify({ type: 'freeze' }));
  document.getElementById('btn-shoot').onclick = shoot;
  
  createColorPalette();
  initJoystick();
  connect();
});

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  window.ws = new WebSocket(`${protocol}://${location.host}`);
  window.ws.onopen = () => console.log('✅ Bağlandı');
  window.ws.onmessage = handleMessage;
  window.ws.onclose = () => setTimeout(connect, 2000);
}

function handleMessage(event) {
  const msg = JSON.parse(event.data);
  switch(msg.type) {
    case 'roomList': updateRoomList(msg.rooms); break;
    case 'roomCreated': case 'roomJoined':
      currentRoomId = msg.roomId;
      createForm.style.display = 'none'; joinForm.style.display = 'none'; menuDiv.style.display = 'none';
      break;
    case 'roomState': updateGameState(msg); break;
    case 'phase': handlePhase(msg); break;
    case 'roundEnd': alert(msg.caught ? 'Yakalandın!' : 'Kurtuldun!'); break;
    case 'error': alert(msg.message); break;
  }
}

function updateRoomList(list) {
  currentRoomList = list;
  const div = document.getElementById('room-list');
  div.innerHTML = list.map(r =>
    `<div style="padding:4px; cursor:pointer" 
          onclick="document.getElementById('join-room-name').value='${r.name}'; 
                   document.getElementById('join-password').style.display='${r.hasPassword?'block':'none'}'; 
                   showJoinForm();">
       ${r.name} (${r.players}/${r.max}) - ${r.map} ${r.hasPassword?'🔒':''}
     </div>`
  ).join('');
}

// ======================== RENK PALETİ ========================
function createColorPalette() {
  const palette = document.createElement('div');
  palette.id = 'color-palette';
  palette.style.cssText = 'display:none; position:absolute; bottom:200px; right:100px; z-index:200; background:rgba(0,0,0,0.9); padding:10px; border-radius:10px; flex-wrap:wrap; gap:6px; max-width:220px;';
  
  const colors = [
    { name: 'Kırmızı', hex: 0xff4444 },
    { name: 'Turuncu', hex: 0xff8800 },
    { name: 'Sarı', hex: 0xffff00 },
    { name: 'Yeşil', hex: 0x00ff00 },
    { name: 'Mavi', hex: 0x4444ff },
    { name: 'Mor', hex: 0x8800ff },
    { name: 'Pembe', hex: 0xff00ff },
    { name: 'Beyaz', hex: 0xffffff },
    { name: 'Gri', hex: 0x888888 },
    { name: 'Siyah', hex: 0x222222 },
    { name: 'Kahve', hex: 0x8B4513 },
    { name: 'Altın', hex: 0xFFD700 },
    { name: 'Elmas', hex: 0x00CED1 },
    { name: 'Zümrüt', hex: 0x00ff88 },
    { name: 'Obsidyen', hex: 0x1A1A2E },
    { name: 'Tahta', hex: 0x8B6914 },
    { name: 'Taş', hex: 0x808080 },
    { name: 'Çimen', hex: 0x7C9D4D },
    { name: 'Kum', hex: 0xC4A46C },
    { name: 'Kar', hex: 0xF0F8FF }
  ];
  
  colors.forEach(c => {
    const btn = document.createElement('button');
    btn.style.cssText = `width:30px; height:30px; background:#${c.hex.toString(16).padStart(6,'0')}; border:2px solid white; border-radius:5px; cursor:pointer;`;
    btn.title = c.name;
    btn.onclick = (e) => {
      e.stopPropagation();
      brushColor = c.hex;
      paintMode = 'brush';
      document.getElementById('btn-pipette').innerText = '🖌️ Boyuyorsun';
      document.getElementById('btn-pipette').style.background = `#${c.hex.toString(16).padStart(6,'0')}`;
      document.getElementById('color-palette').style.display = 'none';
    };
    palette.appendChild(btn);
  });
  
  // Pipetle butonu
  const pipetteBtn = document.createElement('button');
  pipetteBtn.style.cssText = 'width:100%; padding:6px; background:#555; color:white; border:1px solid white; border-radius:5px; cursor:pointer; margin-top:4px;';
  pipetteBtn.innerText = '🔍 Pipetle Kopyala';
  pipetteBtn.onclick = (e) => {
    e.stopPropagation();
    paintMode = 'pipette';
    document.getElementById('btn-pipette').innerText = '🎨 Boya';
    document.getElementById('btn-pipette').style.background = 'rgba(70,130,200,0.8)';
    document.getElementById('color-palette').style.display = 'none';
    pipetteColor();
  };
  palette.appendChild(pipetteBtn);
  
  document.body.appendChild(palette);
}

function toggleBrushMode() {
  if (frozen) return;
  const palette = document.getElementById('color-palette');
  palette.style.display = palette.style.display === 'flex' ? 'none' : 'flex';
}

// ======================== OYUN DURUMU ========================
function updateGameState(state) {
  if (!scene) initScene(state.map);
  gameState = state;
  myPlayerId = state.myId;
  gameUI.style.display = 'block';

  const me = state.players.find(p => p.id === myPlayerId);
  statusText.innerText = state.state === 'lobby' ? 'Lobide' : state.state === 'preparing' ? 'Hazırlanma' : 'Arama';
  timerDiv.innerText = state.timeLeft ? `Süre: ${state.timeLeft}s` : '';
  scoresDiv.innerText = Object.entries(state.scores).map(([id,s]) => `P${id.slice(0,3)}:${s}`).join(' ');

  if (me) {
    frozen = me.frozen;
    btnStart.style.display = (me.role === 'seeker' && state.state === 'lobby') ? 'inline-block' : 'none';
    
    if (me.role === 'hider') { CAMERA_DISTANCE = 5; CAMERA_HEIGHT = 3; }
    else { CAMERA_DISTANCE = 8; CAMERA_HEIGHT = 5; }
    
    if (me.role === 'hider' && state.state === 'preparing') {
      hiderButtons.style.display = 'flex'; seekerButtons.style.display = 'none';
      document.getElementById('btn-pipette').disabled = frozen;
      document.getElementById('btn-freeze').disabled = frozen;
    } else if (me.role === 'seeker' && state.state === 'seeking') {
      hiderButtons.style.display = 'none'; seekerButtons.style.display = 'flex';
    } else {
      hiderButtons.style.display = 'none'; seekerButtons.style.display = 'none';
    }
  }

  const ids = new Set(Object.keys(remoteFigures));
  state.players.forEach(p => {
    if (p.id === myPlayerId) return;
    ids.delete(p.id);
    if (!remoteFigures[p.id]) {
      const fig = createMinecraftCharacter(p.role === 'hider' ? 0.7 : 1.0, p.color);
      fig.position.set(p.x, 0, p.z);
      scene.add(fig);
      remoteFigures[p.id] = fig;
    } else {
      const fig = remoteFigures[p.id];
      fig.position.set(p.x, 0, p.z);
      updateCharacterColor(fig, p.color);
    }
  });
  ids.forEach(id => { scene.remove(remoteFigures[id]); delete remoteFigures[id]; });
}

function handlePhase(msg) { if (gameState) gameState.state = msg.phase; updateGameState(gameState); }
function exitToMenu() {
  gameUI.style.display = 'none'; menuDiv.style.display = 'flex';
  clearInterval(gameInterval);
  if (renderer) { renderer.dispose(); document.body.removeChild(renderer.domElement); }
  scene = null;
}

// ======================== MINECRAFT KARAKTER (DOKULU) ========================
function createMinecraftCharacter(scale = 1.0, color = 0xffffff) {
  const group = new THREE.Group();
  const texture = createMinecraftTexture(color);
  const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7 });

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat.clone());
  head.position.y = 1.4;
  head.userData = { part: 'head' };
  group.add(head);

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.3), mat.clone());
  body.position.y = 0.85;
  body.userData = { part: 'body' };
  group.add(body);

  const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.8, 0.25), mat.clone());
  leftArm.position.set(-0.45, 0.9, 0);
  leftArm.userData = { part: 'leftArm' };
  group.add(leftArm);
  
  const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.8, 0.25), mat.clone());
  rightArm.position.set(0.45, 0.9, 0);
  rightArm.userData = { part: 'rightArm' };
  group.add(rightArm);

  const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.7, 0.25), mat.clone());
  leftLeg.position.set(-0.2, 0.25, 0);
  leftLeg.userData = { part: 'leftLeg' };
  group.add(leftLeg);
  
  const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.7, 0.25), mat.clone());
  rightLeg.position.set(0.2, 0.25, 0);
  rightLeg.userData = { part: 'rightLeg' };
  group.add(rightLeg);

  group.scale.set(scale, scale, scale);
  group.castShadow = true;
  group.receiveShadow = true;
  brushParts = group;
  return group;
}

function updateCharacterColor(group, color) {
  const texture = createMinecraftTexture(color);
  group.traverse(child => {
    if (child.isMesh && child.material.map) {
      child.material.map = texture;
      child.material.needsUpdate = true;
    }
  });
}

// Fırça ile kendini boyama
function brushPaint() {
  if (!myFigure || !brushParts) return;
  const color = brushColor;
  // Tüm vücudu boya (fırça efekti - kademeli)
  myFigure.traverse(child => {
    if (child.isMesh && child.material.map) {
      const texture = createMinecraftTexture(color);
      child.material.map = texture;
      child.material.needsUpdate = true;
    }
  });
  window.ws.send(JSON.stringify({ type: 'color', color }));
}

// Pipetle renk kopyalama
function pipetteColor() {
  if (!myFigure) return;
  const pos = myFigure.position;
  let closest = 3, color = null;
  mapObjects.forEach(o => {
    const d = pos.distanceTo(o.position);
    if (d < closest) { closest = d; color = o.userData.color; }
  });
  if (color !== null) {
    brushColor = color;
    myFigure.traverse(child => {
      if (child.isMesh && child.material.map) {
        const texture = createMinecraftTexture(color);
        child.material.map = texture;
        child.material.needsUpdate = true;
      }
    });
    window.ws.send(JSON.stringify({ type: 'color', color }));
  }
}

// ======================== SAHNE KURULUMU ========================
function initScene(mapType) {
  if (scene) exitToMenu();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.Fog(0x87CEEB, 40, 100);
  camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 200);
  renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0x8B9DC3));
  const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
  sun.position.set(30, 60, 20);
  sun.castShadow = true; sun.receiveShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  scene.add(sun);

  const groundGeo = new THREE.PlaneGeometry(80, 80);
  const groundTex = createMinecraftTexture(0x7C9D4D);
  groundTex.repeat.set(5, 5);
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  collisionBoxes = [];
  mapObjects = [];
  bullets = [];

  buildMinecraftWorld();

  myFigure = createMinecraftCharacter(1.0, 0xffffff);
  myFigure.position.set(0, 0, 0);
  scene.add(myFigure);
  remoteFigures = {};

  gameInterval = setInterval(fixedUpdate, FIXED_FRAME_MS);
}

function buildMinecraftWorld() {
  const textures = {};
  const getTex = (color) => {
    if (!textures[color]) textures[color] = createMinecraftTexture(color);
    return textures[color];
  };

  const add = (color, x, y, z, w = 1, h = 1, d = 1) => {
    w *= 1.5; h *= 1.5; d *= 1.5;
    const geo = new THREE.BoxGeometry(w, h, d);
    const tex = getTex(color);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
    const b = new THREE.Mesh(geo, mat);
    b.position.set(x, y + h / 2, z);
    b.castShadow = true; b.receiveShadow = true;
    b.userData = { color };
    collisionBoxes.push({
      min: new THREE.Vector3(x - w/2, y, z - d/2),
      max: new THREE.Vector3(x + w/2, y + h, z + d/2)
    });
    scene.add(b);
    mapObjects.push(b);
    return b;
  };

  // Ev
  const hx = 12, hz = -12;
  for (let ix = -4; ix <= 4; ix++)
    for (let iz = -4; iz <= 4; iz++)
      add(0x808080, hx + ix*1.5, 0, hz + iz*1.5, 1, 0.3, 1);
  for (let i = -4; i <= 4; i++) {
    add(0x8B6914, hx + i*1.5, 0.5, hz - 4.5, 1, 3, 1);
    if (i < -1 || i > 0) add(0x8B6914, hx + i*1.5, 0.5, hz + 4.5, 1, 3, 1);
    add(0x8B6914, hx - 4.5, 0.5, hz + i*1.5, 1, 3, 1);
    add(0x8B6914, hx + 4.5, 0.5, hz + i*1.5, 1, 3, 1);
  }
  for (let ix = -5; ix <= 5; ix++)
    for (let iz = -5; iz <= 5; iz++)
      add(0xB53C1A, hx + ix*1.5, 3.5, hz + iz*1.5, 1, 0.5, 1);

  // Nether portal
  const px = -15, pz = 0;
  add(0x1A1A2E, px, 0, pz, 0.8, 4, 0.8);
  add(0x1A1A2E, px, 0, pz + 2.5, 0.8, 4, 0.8);
  add(0x1A1A2E, px, 3.5, pz + 1.25, 0.8, 0.8, 2.5);
  for (let iy = 0; iy < 4; iy++)
    for (let iz = 0; iz < 1; iz++)
      add(0x800080, px, 0.5 + iy*1.5, pz + 0.75 + iz*1.5, 0.2, 1, 1);

  // Maden
  const mx = -10, mz = 10;
  add(0x6B6B6B, mx, 0, mz, 2, 0.3, 2);
  add(0xFFD700, mx - 0.5, 0.3, mz, 0.3, 0.3, 0.3);
  add(0x00CED1, mx + 0.5, 0.3, mz + 0.5, 0.3, 0.3, 0.3);

  // Ağaçlar
  const tree = (tx, tz) => {
    add(0x6B4226, tx, 0, tz, 0.6, 3, 0.6);
    add(0x2D5A27, tx, 3, tz, 2.5, 2, 2.5);
  };
  tree(-5, 0); tree(5, -5); tree(0, -8); tree(8, 3); tree(-3, 8);
  tree(15, -15); tree(-15, -15); tree(15, 15); tree(-15, 15);

  // Gölet
  for (let ix = 4; ix <= 6; ix++)
    for (let iz = 4; iz <= 6; iz++)
      add(0x3399FF, ix*1.5, 0, iz*1.5, 1, 0.3, 1);
}

// ======================== ÇARPIŞMA ========================
function resolveCollisions(pos) {
  const r = 0.3;
  for (const box of collisionBoxes) {
    const near = new THREE.Vector3(
      Math.max(box.min.x, Math.min(pos.x, box.max.x)),
      Math.max(box.min.y, Math.min(pos.y, box.max.y)),
      Math.max(box.min.z, Math.min(pos.z, box.max.z))
    );
    if (pos.distanceTo(near) < r) {
      const dir = pos.clone().sub(near).normalize();
      pos.copy(near.clone().add(dir.multiplyScalar(r)));
    }
  }
}

function checkCameraCollision(camPos, targetPos) {
  raycaster.set(camPos, targetPos.clone().sub(camPos).normalize());
  const allObjects = [];
  scene.traverse(child => {
    if (child.isMesh && child !== myFigure && !Object.values(remoteFigures).includes(child) && child.userData.color !== undefined) {
      allObjects.push(child);
    }
  });
  const intersects = raycaster.intersectObjects(allObjects, true);
  if (intersects.length > 0 && intersects[0].distance < camPos.distanceTo(targetPos) - 0.5) {
    return intersects[0].point.clone().add(raycaster.ray.direction.clone().multiplyScalar(0.3));
  }
  return camPos;
}

// ======================== HAREKET ========================
const key = { w: false, a: false, s: false, d: false };
window.addEventListener('keydown', e => {
  switch (e.key.toLowerCase()) {
    case 'w': key.w = true; e.preventDefault(); break;
    case 'a': key.a = true; e.preventDefault(); break;
    case 's': key.s = true; e.preventDefault(); break;
    case 'd': key.d = true; e.preventDefault(); break;
    case 'q': cameraAngle += 0.05; break;
    case 'e': cameraAngle -= 0.05; break;
  }
});
window.addEventListener('keyup', e => {
  switch (e.key.toLowerCase()) {
    case 'w': key.w = false; break;
    case 'a': key.a = false; break;
    case 's': key.s = false; break;
    case 'd': key.d = false; break;
  }
});

window.addEventListener('wheel', e => {
  CAMERA_DISTANCE += e.deltaY * 0.01;
  CAMERA_DISTANCE = Math.max(CAMERA_MIN, Math.min(CAMERA_MAX, CAMERA_DISTANCE));
  CAMERA_HEIGHT = CAMERA_DISTANCE * 0.6;
});

function initJoystick() {
  const jBase = document.getElementById('joystick-base');
  const jThumb = document.getElementById('joystick-thumb');
  let joyVec = { x: 0, z: 0 };

  jBase.addEventListener('touchstart', e => {
    e.preventDefault();
    if (joystickTouchId === null) joystickTouchId = e.changedTouches[0].identifier;
  });
  jBase.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === joystickTouchId) {
        const rect = jBase.getBoundingClientRect();
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        let dx = t.clientX - cx, dy = t.clientY - cy;
        const maxR = 40, dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > maxR) { dx *= maxR / dist; dy *= maxR / dist; }
        jThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        joyVec.x = dx / maxR;
        joyVec.z = dy / maxR;
        break;
      }
    }
  });
  jBase.addEventListener('touchend', e => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === joystickTouchId) {
      joystickTouchId = null;
      jThumb.style.transform = 'translate(-50%, -50%)';
      joyVec.x = 0; joyVec.z = 0;
      break;
    }
  });

  const drag = document.createElement('div');
  drag.style.cssText = 'position:absolute; top:0; right:0; width:40%; height:70%; z-index:5; touch-action:none;';
  document.body.appendChild(drag);

  drag.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.touches.length === 1 && cameraTouchId === null) {
      cameraTouchId = e.touches[0].identifier;
      cameraTouchStartX = e.touches[0].clientX;
    } else if (e.touches.length === 2) {
      cameraTouchId = null;
      pinchStartDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  });
  drag.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 1 && cameraTouchId !== null) {
      for (const t of e.touches) {
        if (t.identifier === cameraTouchId) {
          cameraAngle -= (t.clientX - cameraTouchStartX) * 0.01;
          cameraTouchStartX = t.clientX;
          break;
        }
      }
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      CAMERA_DISTANCE -= (dist - pinchStartDist) * 0.02;
      CAMERA_DISTANCE = Math.max(CAMERA_MIN, Math.min(CAMERA_MAX, CAMERA_DISTANCE));
      CAMERA_HEIGHT = CAMERA_DISTANCE * 0.6;
      pinchStartDist = dist;
    }
  });
  drag.addEventListener('touchend', e => {
    e.preventDefault();
    if (e.touches.length < 2) pinchStartDist = 0;
    if (e.touches.length === 0) cameraTouchId = null;
  });

  window.joyVec = joyVec;
}

function handleMovement() {
  if (!myFigure || !window.ws || window.ws.readyState !== WebSocket.OPEN) return;
  let dx = 0, dz = 0;
  if (key.w) dz++;
  if (key.s) dz--;
  if (key.a) dx--;
  if (key.d) dx++;
  if (window.joyVec) { dx += window.joyVec.x; dz += -window.joyVec.z; }
  if (dx === 0 && dz === 0) return;

  const len = Math.sqrt(dx * dx + dz * dz);
  dx /= len; dz /= len;
  
  const forward = new THREE.Vector3(-Math.sin(cameraAngle), 0, -Math.cos(cameraAngle));
  const right = new THREE.Vector3(Math.cos(cameraAngle), 0, -Math.sin(cameraAngle));
  const move = right.multiplyScalar(dx).add(forward.multiplyScalar(dz)).normalize();

  const newPos = myFigure.position.clone().add(move.multiplyScalar(0.2));
  newPos.x = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, newPos.x));
  newPos.z = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, newPos.z));
  resolveCollisions(newPos);
  myFigure.position.copy(newPos);
  window.ws.send(JSON.stringify({ type: 'move', x: newPos.x, z: newPos.z }));

  // Fırça modunda sürekli boya
  if (paintMode === 'brush') {
    brushPaint();
  }
}

// ======================== ATEŞ ETME ========================
function shoot() {
  if (!window.ws || !myFigure) return;
  const dir = new THREE.Vector3(-Math.sin(cameraAngle), 0, -Math.cos(cameraAngle));
  const startPos = myFigure.position.clone().add(new THREE.Vector3(0, 1.2, 0));
  const bullet = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
  bullet.position.copy(startPos);
  scene.add(bullet);
  bullets.push({ mesh: bullet, velocity: dir.multiplyScalar(0.7), life: 80 });
  window.ws.send(JSON.stringify({ type: 'shoot', dir: { x: dir.x, z: dir.z }, origin: { x: startPos.x, z: startPos.z } }));
}

// ======================== ANA DÖNGÜ ========================
function fixedUpdate() {
  handleMovement();
  
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.mesh.position.add(b.velocity);
    b.life--;
    if (b.life <= 0) { scene.remove(b.mesh); bullets.splice(i, 1); }
  }

  if (camera && myFigure) {
    const target = myFigure.position.clone().add(new THREE.Vector3(0, 1.2, 0));
    const ox = Math.sin(cameraAngle) * CAMERA_DISTANCE;
    const oz = Math.cos(cameraAngle) * CAMERA_DISTANCE;
    let desiredPos = new THREE.Vector3(target.x + ox, target.y + CAMERA_HEIGHT, target.z + oz);
    desiredPos = checkCameraCollision(desiredPos, target);
    camera.position.lerp(desiredPos, 0.2);
    camera.lookAt(target);
  }
  
  if (renderer && scene && camera) renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  if (camera) {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }
});