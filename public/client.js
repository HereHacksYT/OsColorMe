import * as THREE from 'three';

// --- Global değişkenler ---
window.ws = null;
let myPlayerId = null;
let currentRoomId = null;
let gameState = null;

// UI elementleri (DOM yüklendikten sonra)
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

let currentRoomList = [];

const FIXED_FRAME_MS = 1000 / 30;
let gameInterval = null;

let cameraAngle = 0;
const CAMERA_DISTANCE = 12;
const CAMERA_HEIGHT = 8;

let joystickTouchId = null;
let cameraTouchId = null;
let cameraTouchStartX = 0;

const WORLD_LIMIT = 20;
let collisionBoxes = [];

// --- Global buton fonksiyonları (HTML'den çağrılır) ---
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
  window.ws.send(JSON.stringify({
    type: 'createRoom',
    settings: { name, map, hiderPrepTime: hiderTime, seekerTime, maxPlayers, public: isPublic, password }
  }));
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

window.selectRoom = (name, hasPass) => {
  document.getElementById('join-room-name').value = name;
  document.getElementById('join-password').style.display = hasPass ? 'block' : 'none';
  document.getElementById('search-results').innerHTML = '';
};

// --- Başlangıç ---
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

  document.getElementById('btn-leave').onclick = () => {
    window.ws.send(JSON.stringify({ type: 'leaveRoom' }));
    exitToMenu();
  };
  btnStart.onclick = () => window.ws.send(JSON.stringify({ type: 'startGame' }));

  document.getElementById('btn-pipette').onclick = pipette;
  document.getElementById('btn-freeze').onclick = () => window.ws.send(JSON.stringify({ type: 'freeze' }));
  document.getElementById('btn-catch').onclick = () => window.ws.send(JSON.stringify({ type: 'catch' }));

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

// --- Mesaj işleme ---
function handleMessage(event) {
  const msg = JSON.parse(event.data);
  switch(msg.type) {
    case 'roomList': updateRoomList(msg.rooms); break;
    case 'roomCreated': case 'roomJoined':
      currentRoomId = msg.roomId;
      createForm.style.display = 'none';
      joinForm.style.display = 'none';
      menuDiv.style.display = 'none';
      break;
    case 'roomState': updateGameState(msg); break;
    case 'phase': handlePhase(msg); break;
    case 'roundEnd': alert(msg.caught ? 'Yakalandın!' : 'Kurtuldun!'); break;
    case 'catchFail': alert(msg.message); break;
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
  }

  // diğer oyuncular
  const ids = new Set(Object.keys(remoteFigures));
  state.players.forEach(p => {
    if (p.id === myPlayerId) return;
    ids.delete(p.id);
    if (!remoteFigures[p.id]) {
      const geo = new THREE.CapsuleGeometry(0.5, 0.8, 2, 8);
      const mat = new THREE.MeshStandardMaterial({ color: p.color });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.position.set(p.x, 0.9, p.z);
      scene.add(mesh);
      remoteFigures[p.id] = mesh;
    } else {
      const m = remoteFigures[p.id];
      m.position.set(p.x, 0.9, p.z);
      m.material.color.set(p.color);
    }
  });
  ids.forEach(id => { scene.remove(remoteFigures[id]); delete remoteFigures[id]; });
}

function handlePhase(msg) { if (gameState) gameState.state = msg.phase; updateGameState(gameState); }

function exitToMenu() {
  gameUI.style.display = 'none';
  menuDiv.style.display = 'flex';
  clearInterval(gameInterval);
  if (renderer) { renderer.dispose(); document.body.removeChild(renderer.domElement); }
  scene = null;
}

// --- 3D sahne ---
function initScene(mapType) {
  if (scene) exitToMenu();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.Fog(0x87CEEB, 25, 60);
  camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 150);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0x8B9DC3));
  const dir = new THREE.DirectionalLight(0xffeedd, 1.2);
  dir.position.set(20,40,15); dir.castShadow = dir.receiveShadow = true;
  scene.add(dir);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(50,50), new THREE.MeshStandardMaterial({color:0x7C9D4D}));
  ground.rotation.x = -Math.PI/2; ground.receiveShadow = true;
  scene.add(ground);

  collisionBoxes = []; mapObjects = [];

  if (mapType === 'minecraft') {
    // basit bir ev yapısı
    const addBlock = (color, x, y, z, w=1, h=1, d=1) => {
      w*=1.5; h*=1.5; d*=1.5;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), new THREE.MeshStandardMaterial({color}));
      b.position.set(x, y+h/2, z); b.castShadow = b.receiveShadow = true;
      b.userData = { color };
      collisionBoxes.push({ min: new THREE.Vector3(x-w/2, y, z-d/2), max: new THREE.Vector3(x+w/2, y+h, z+d/2) });
      scene.add(b); mapObjects.push(b);
    };
    // zemin
    for(let ix=-4; ix<=4; ix++) for(let iz=-4; iz<=4; iz++) addBlock(0x808080, ix*1.5, 0, iz*1.5, 1,0.3,1);
    // duvarlar
    for(let i=-4;i<=4;i++) { addBlock(0x8B6B4D, i*1.5, 0.5, -4.5, 1,3,1); addBlock(0x8B6B4D, i*1.5, 0.5, 4.5, 1,3,1); if(i<-1||i>0) addBlock(0x8B6B4D, -4.5, 0.5, i*1.5, 1,3,1); addBlock(0x8B6B4D, 4.5, 0.5, i*1.5, 1,3,1); }
    // çatı
    for(let ix=-4;ix<=4;ix++) for(let iz=-4;iz<=4;iz++) addBlock(0xB53C1A, ix*1.5, 3.5, iz*1.5, 1,0.5,1);
  } else {
    const add = (color, x, y, z, w=1,h=1,d=1) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), new THREE.MeshStandardMaterial({color}));
      b.position.set(x,y+h/2,z); b.castShadow=b.receiveShadow=true; b.userData={color};
      collisionBoxes.push({ min: new THREE.Vector3(x-w/2, y, z-d/2), max: new THREE.Vector3(x+w/2, y+h, z+d/2) });
      scene.add(b); mapObjects.push(b);
    };
    add(0x8B0000, 1.5,0,2, 0.8,1.2,0.8);
    add(0x5C4033, -2.5,0,1, 1.5,0.4,2);
  }

  myFigure = new THREE.Mesh(new THREE.CapsuleGeometry(0.5,0.8,2,8), new THREE.MeshStandardMaterial({color:0xffffff}));
  myFigure.castShadow = myFigure.receiveShadow = true;
  myFigure.position.y = 0.9;
  scene.add(myFigure);
  remoteFigures = {};

  gameInterval = setInterval(fixedUpdate, FIXED_FRAME_MS);
}

// --- Çarpışma ---
function resolveCollisions(pos) {
  const r = 0.4;
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

// --- Hareket ve kamera ---
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
    case 'w': key.w=false; e.preventDefault(); break;
    case 'a': key.a=false; e.preventDefault(); break;
    case 's': key.s=false; e.preventDefault(); break;
    case 'd': key.d=false; e.preventDefault(); break;
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
    for(const t of e.changedTouches) {
      if(t.identifier === joystickTouchId) {
        joystickTouchId = null;
        jThumb.style.transform = 'translate(-50%, -50%)';
        joyVec.x = 0; joyVec.z = 0;
        break;
      }
    }
  });

  // kamera sürükleme
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
  const forward = new THREE.Vector3(Math.sin(cameraAngle), 0, Math.cos(cameraAngle));
  const right = new THREE.Vector3(Math.cos(cameraAngle), 0, -Math.sin(cameraAngle));
  const move = right.multiplyScalar(dx).add(forward.multiplyScalar(-dz)).normalize();

  const newPos = myFigure.position.clone().add(move.multiplyScalar(0.15));
  newPos.x = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, newPos.x));
  newPos.z = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, newPos.z));
  resolveCollisions(newPos);
  myFigure.position.copy(newPos);
  window.ws.send(JSON.stringify({ type: 'move', x: newPos.x, z: newPos.z }));
}

function fixedUpdate() {
  handleMovement();
  if(camera && myFigure) {
    const target = myFigure.position;
    const ox = Math.sin(cameraAngle) * CAMERA_DISTANCE;
    const oz = Math.cos(cameraAngle) * CAMERA_DISTANCE;
    camera.position.lerp(new THREE.Vector3(target.x+ox, target.y+CAMERA_HEIGHT, target.z+oz), 0.15);
    camera.lookAt(target.x, target.y+0.5, target.z);
  }
  if(renderer && scene && camera) renderer.render(scene, camera);
}

function pipette() {
  if(!myFigure || frozen) return;
  const pos = myFigure.position;
  let closest = 2.5, color = null;
  mapObjects.forEach(o => { const d = pos.distanceTo(o.position); if(d < closest) { closest = d; color = o.userData.color; } });
  if(color !== null) {
    myColor = color;
    myFigure.material.color.set(color);
    window.ws.send(JSON.stringify({ type: 'color', color }));
  }
}

window.addEventListener('resize', () => {
  if(camera) { camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); }
});