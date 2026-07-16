import * as THREE from 'three';

// ======================== GLOBAL ========================
window.ws = null;
let myPlayerId = null, currentRoomId = null, gameState = null;
let menuDiv, createForm, joinForm, gameUI, statusText, timerDiv, scoresDiv, btnStart, hiderButtons, seekerButtons;
let scene, camera, renderer, mapObjects = [], myFigure, remoteFigures = {}, myColor = 0xffffff, frozen = false;
let currentRoomList = [], gameInterval = null;
let cameraAngle = Math.PI, CAMERA_DISTANCE = 8, CAMERA_HEIGHT = 5;
let joystickTouchId = null, cameraTouchId = null, cameraTouchStartX = 0;
const WORLD_LIMIT = 18, FIXED_FRAME_MS = 1000 / 30;
let collisionBoxes = [];

// Mermiler
let bullets = [];

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
  document.getElementById('btn-pipette').onclick = pipette;
  document.getElementById('btn-freeze').onclick = () => window.ws.send(JSON.stringify({ type: 'freeze' }));
  document.getElementById('btn-shoot').onclick = shoot;
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
    case 'catchFail': break; // artık ateş et var, hata mesajına gerek yok
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
    // pozisyon güncelleme (sadece uzak oyuncular için, kendi figürümüze dokunma)
  }

  // Uzak oyuncular
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
      fig.children.forEach(child => { if (child.material) child.material.color.set(p.color); });
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

// ======================== MINECRAFT KARAKTER MODELİ ========================
function createMinecraftCharacter(scale = 1.0, color = 0xffffff) {
  const group = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });

  // Kafa (küp)
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), skinMat);
  head.position.y = 1.4;
  group.add(head);

  // Gövde
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.3), skinMat);
  body.position.y = 0.85;
  group.add(body);

  // Sol kol
  const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.8, 0.25), skinMat);
  leftArm.position.set(-0.45, 0.9, 0);
  group.add(leftArm);
  // Sağ kol
  const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.8, 0.25), skinMat);
  rightArm.position.set(0.45, 0.9, 0);
  group.add(rightArm);

  // Sol bacak
  const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.7, 0.25), skinMat);
  leftLeg.position.set(-0.2, 0.25, 0);
  group.add(leftLeg);
  // Sağ bacak
  const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.7, 0.25), skinMat);
  rightLeg.position.set(0.2, 0.25, 0);
  group.add(rightLeg);

  group.scale.set(scale, scale, scale);
  group.castShadow = true;
  group.receiveShadow = true;
  return group;
}

// Ebenin kılıcı (sağ kola eklenir)
function createSword() {
  const swordGroup = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.6, 0.05), new THREE.MeshStandardMaterial({ color: 0xAAAAAA, metalness: 0.8 }));
  blade.position.y = 0.4;
  swordGroup.add(blade);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.1), new THREE.MeshStandardMaterial({ color: 0x8B4513 }));
  guard.position.y = 0.15;
  swordGroup.add(guard);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.08), new THREE.MeshStandardMaterial({ color: 0x5C4033 }));
  handle.position.y = -0.1;
  swordGroup.add(handle);
  return swordGroup;
}

// ======================== SAHNE KURULUMU ========================
function initScene(mapType) {
  if (scene) exitToMenu();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.Fog(0x87CEEB, 30, 80);
  camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 150);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0x8B9DC3));
  const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
  sun.position.set(20, 40, 15); sun.castShadow = sun.receiveShadow = true;
  sun.shadow.mapSize.set(2048,2048);
  scene.add(sun);

  // Zemin
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(50,50), new THREE.MeshStandardMaterial({color:0x7C9D4D}));
  ground.rotation.x = -Math.PI/2; ground.receiveShadow = true;
  scene.add(ground);

  collisionBoxes = []; mapObjects = []; bullets = [];

  if (mapType === 'minecraft') {
    buildMinecraftHouse();
  } else {
    buildSimpleHouse();
  }

  // Karakter
  myFigure = createMinecraftCharacter(1.0, 0xffffff);
  myFigure.position.set(2, 0, 2); // kapının önü
  scene.add(myFigure);
  remoteFigures = {};

  gameInterval = setInterval(fixedUpdate, FIXED_FRAME_MS);
}

function buildMinecraftHouse() {
  const wood = 0x8B6B4D, plank = 0xBC8F5F, stone = 0x808080, glass = 0x90CAF9;
  const leaves = 0x2D5A27, log = 0x6B4226, water = 0x3399FF, roof = 0xB53C1A;

  const add = (color, x, y, z, w=1, h=1, d=1) => {
    w*=1.5; h*=1.5; d*=1.5;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), new THREE.MeshStandardMaterial({color}));
    b.position.set(x, y+h/2, z);
    b.castShadow = b.receiveShadow = true;
    b.userData = { color };
    collisionBoxes.push({ min: new THREE.Vector3(x-w/2, y, z-d/2), max: new THREE.Vector3(x+w/2, y+h, z+d/2) });
    scene.add(b); mapObjects.push(b);
  };

  // Zemin (taş)
  for(let ix=-4; ix<=4; ix++) for(let iz=-4; iz<=4; iz++) add(stone, ix*1.5, 0, iz*1.5, 1,0.3,1);

  // Duvarlar ahşap
  for(let i=-4;i<=4;i++) {
    add(wood, i*1.5, 0.5, -4.5, 1,3,1); // kuzey
    if(i<-1 || i>0) add(wood, i*1.5, 0.5, 4.5, 1,3,1); // güney (kapı boşluğu)
    add(wood, -4.5, 0.5, i*1.5, 1,3,1); // batı
    add(wood, 4.5, 0.5, i*1.5, 1,3,1); // doğu
  }
  // Pencereler (cam)
  add(glass, -2*1.5, 1.5, -4.5, 1,1,0.2);
  add(glass, 2*1.5, 1.5, -4.5, 1,1,0.2);

  // Çatı
  for(let ix=-4;ix<=4;ix++) for(let iz=-4;iz<=4;iz++) add(roof, ix*1.5, 3.5, iz*1.5, 1,0.5,1);

  // Bahçe ağaçları
  const tree = (tx, tz) => {
    add(log, tx, 0, tz, 0.6, 3, 0.6);
    add(leaves, tx, 3, tz, 2, 2, 2);
  };
  tree(-7,-7); tree(7,-7); tree(-7,7); tree(7,7);

  // Gölet
  for(let ix=6;ix<=7;ix++) for(let iz=6;iz<=7;iz++) add(water, ix*1.5, 0, iz*1.5, 1,0.3,1);
}

function buildSimpleHouse() {
  const add = (color, x, y, z, w=1, h=1, d=1) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), new THREE.MeshStandardMaterial({color}));
    b.position.set(x,y+h/2,z); b.castShadow=b.receiveShadow=true; b.userData={color};
    collisionBoxes.push({ min: new THREE.Vector3(x-w/2,y,z-d/2), max: new THREE.Vector3(x+w/2,y+h,z+d/2) });
    scene.add(b); mapObjects.push(b);
  };
  add(0x8B0000, 1.5,0,2, 0.8,1.2,0.8);
  add(0x5C4033, -2.5,0,1, 1.5,0.4,2);
}

// ======================== ÇARPIŞMA ========================
function resolveCollisions(pos) {
  const r = 0.3;
  for(const box of collisionBoxes) {
    const near = new THREE.Vector3(
      Math.max(box.min.x, Math.min(pos.x, box.max.x)),
      Math.max(box.min.y, Math.min(pos.y, box.max.y)),
      Math.max(box.min.z, Math.min(pos.z, box.max.z))
    );
    if(pos.distanceTo(near) < r) {
      const dir = pos.clone().sub(near).normalize();
      pos.copy(near.clone().add(dir.multiplyScalar(r)));
    }
  }
}

// ======================== HAREKET & KAMERA ========================
const key = { w:false, a:false, s:false, d:false };
window.addEventListener('keydown', e => {
  switch(e.key.toLowerCase()) {
    case 'w': key.w=true; e.preventDefault(); break;
    case 'a': key.a=true; e.preventDefault(); break;
    case 's': key.s=true; e.preventDefault(); break;
    case 'd': key.d=true; e.preventDefault(); break;
    case 'q': cameraAngle += 0.05; break;
    case 'e': cameraAngle -= 0.05; break;
  }
});
window.addEventListener('keyup', e => {
  switch(e.key.toLowerCase()) {
    case 'w': key.w=false; break;
    case 'a': key.a=false; break;
    case 's': key.s=false; break;
    case 'd': key.d=false; break;
  }
});

function initJoystick() {
  const jBase = document.getElementById('joystick-base');
  const jThumb = document.getElementById('joystick-thumb');
  let joyVec = { x:0, z:0 };

  jBase.addEventListener('touchstart', e => {
    e.preventDefault();
    if(joystickTouchId===null) joystickTouchId = e.changedTouches[0].identifier;
  });
  jBase.addEventListener('touchmove', e => {
    e.preventDefault();
    for(const t of e.changedTouches) {
      if(t.identifier === joystickTouchId) {
        const rect = jBase.getBoundingClientRect();
        const cx = rect.left+rect.width/2, cy = rect.top+rect.height/2;
        let dx = t.clientX - cx, dy = t.clientY - cy;
        const maxR = 40, dist = Math.sqrt(dx*dx+dy*dy);
        if(dist > maxR) { dx *= maxR/dist; dy *= maxR/dist; }
        jThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        joyVec.x = dx/maxR; joyVec.z = dy/maxR;
        break;
      }
    }
  });
  jBase.addEventListener('touchend', e => {
    e.preventDefault();
    for(const t of e.changedTouches) if(t.identifier === joystickTouchId) {
      joystickTouchId = null;
      jThumb.style.transform = 'translate(-50%, -50%)';
      joyVec.x = 0; joyVec.z = 0;
      break;
    }
  });

  // Kamera sürükleme
  const drag = document.createElement('div');
  drag.style.cssText = 'position:absolute; top:0; right:0; width:40%; height:70%; z-index:5; touch-action:none;';
  document.body.appendChild(drag);
  drag.addEventListener('touchstart', e => {
    e.preventDefault();
    if(cameraTouchId===null) { cameraTouchId = e.changedTouches[0].identifier; cameraTouchStartX = e.changedTouches[0].clientX; }
  });
  drag.addEventListener('touchmove', e => {
    e.preventDefault();
    for(const t of e.changedTouches) {
      if(t.identifier === cameraTouchId) {
        cameraAngle -= (t.clientX - cameraTouchStartX) * 0.01;
        cameraTouchStartX = t.clientX;
        break;
      }
    }
  });
  drag.addEventListener('touchend', e => {
    e.preventDefault();
    for(const t of e.changedTouches) if(t.identifier === cameraTouchId) { cameraTouchId = null; break; }
  });

  window.joyVec = joyVec;
}

function handleMovement() {
  if(!myFigure || !window.ws || window.ws.readyState !== WebSocket.OPEN) return;
  let dx = 0, dz = 0;
  if(key.w) dz--;
  if(key.s) dz++;
  if(key.a) dx--;
  if(key.d) dx++;
  if(window.joyVec) { dx += window.joyVec.x; dz += window.joyVec.z; }
  if(dx===0 && dz===0) return;

  const len = Math.sqrt(dx*dx+dz*dz);
  dx /= len; dz /= len;
  // Kamera yönüne göre hareket (ters değil!)
  const forward = new THREE.Vector3(-Math.sin(cameraAngle), 0, -Math.cos(cameraAngle));
  const right = new THREE.Vector3(Math.cos(cameraAngle), 0, -Math.sin(cameraAngle));
  const move = right.multiplyScalar(dx).add(forward.multiplyScalar(dz)).normalize();

  const newPos = myFigure.position.clone().add(move.multiplyScalar(0.15));
  newPos.x = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, newPos.x));
  newPos.z = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, newPos.z));
  resolveCollisions(newPos);
  myFigure.position.copy(newPos);
  window.ws.send(JSON.stringify({ type: 'move', x: newPos.x, z: newPos.z }));
}

// ======================== ATEŞ ETME ========================
function shoot() {
  if (!window.ws || !myFigure) return;
  const dir = new THREE.Vector3(-Math.sin(cameraAngle), 0, -Math.cos(cameraAngle));
  const startPos = myFigure.position.clone().add(new THREE.Vector3(0, 1.2, 0));
  const bullet = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff0000 })
  );
  bullet.position.copy(startPos);
  scene.add(bullet);
  bullets.push({ mesh: bullet, velocity: dir.multiplyScalar(0.5), life: 60 });
  
  // Sunucuya gönder (menzil kontrolü sunucuda)
  window.ws.send(JSON.stringify({ type: 'shoot', dir: { x: dir.x, z: dir.z }, origin: { x: startPos.x, z: startPos.z } }));
}

// ======================== PİPETLE ========================
function pipette() {
  if(!myFigure || frozen) return;
  const pos = myFigure.position;
  let closest = 2.5, color = null;
  mapObjects.forEach(o => { const d = pos.distanceTo(o.position); if(d < closest) { closest = d; color = o.userData.color; } });
  if(color !== null) {
    myColor = color;
    myFigure.children.forEach(child => { if (child.material) child.material.color.set(color); });
    window.ws.send(JSON.stringify({ type: 'color', color }));
  }
}

// ======================== ANA DÖNGÜ ========================
function fixedUpdate() {
  handleMovement();
  // Mermileri güncelle
  for(let i=bullets.length-1; i>=0; i--) {
    const b = bullets[i];
    b.mesh.position.add(b.velocity);
    b.life--;
    if(b.life <= 0) { scene.remove(b.mesh); bullets.splice(i,1); }
  }
  // Kamera
  if(camera && myFigure) {
    const target = myFigure.position.clone().add(new THREE.Vector3(0, 1.2, 0));
    const ox = Math.sin(cameraAngle) * CAMERA_DISTANCE;
    const oz = Math.cos(cameraAngle) * CAMERA_DISTANCE;
    camera.position.lerp(new THREE.Vector3(target.x+ox, target.y+CAMERA_HEIGHT, target.z+oz), 0.15);
    camera.lookAt(target);
  }
  if(renderer && scene && camera) renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  if(camera) { camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); }
});