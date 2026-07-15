import * as THREE from 'three';

// ---------- Bağlantı ----------
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${protocol}://${location.host}`;
let ws;
let myPlayerId = null;
let currentRoom = null;
let gameState = null; // en son roomState

// UI elemanları
const menuDiv = document.getElementById('menu');
const createForm = document.getElementById('create-form');
const joinForm = document.getElementById('join-form');
const gameUI = document.getElementById('game-ui');
const statusText = document.getElementById('status-text');
const timerDiv = document.getElementById('timer');
const scoresDiv = document.getElementById('scores');
const hiderButtons = document.getElementById('hider-buttons');
const seekerButtons = document.getElementById('seeker-buttons');
const joystickContainer = document.getElementById('joystick-container');

// Three.js globalleri
let scene, camera, renderer;
let mapObjects = []; // renk alınacak objeler
let myFigure, remoteFigures = {}; // id -> mesh
let myColor = 0xffffff;
let frozen = false;

// ---- Bağlantıyı başlat ----
function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => console.log('Connected');
  ws.onmessage = handleServerMessage;
  ws.onclose = () => setTimeout(connect, 2000);
}
connect();

// ---- Menü & Form olayları ----
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
};
document.getElementById('btn-join-cancel').onclick = () => {
  joinForm.style.display = 'none';
  menuDiv.style.display = 'flex';
};

// Açık/Kapalı radyo butonları
document.querySelectorAll('input[name="visibility"]').forEach(r => {
  r.onchange = () => {
    document.getElementById('password-field').style.display = r.value === 'private' ? 'block' : 'none';
  };
});

// Oda oluştur
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

// Odaya katıl
document.getElementById('btn-join-confirm').onclick = () => {
  const roomName = document.getElementById('join-room-name').value.trim();
  if (!roomName) return;
  const password = document.getElementById('join-password').value;
  ws.send(JSON.stringify({ type: 'joinRoom', roomName, password }));
};

// Oda arama (anlık liste yok, manuel)
// Katıl formunda oda ismi yazıp butona basılır.

// Çık butonu
document.getElementById('btn-leave').onclick = () => {
  ws.send(JSON.stringify({ type: 'leaveRoom' }));
  exitToMenu();
};

function exitToMenu() {
  gameUI.style.display = 'none';
  menuDiv.style.display = 'flex';
  if (scene) {
    // temizlik
    renderer.dispose();
    document.body.removeChild(renderer.domElement);
  }
  scene = null;
  currentRoom = null;
  myPlayerId = null;
}

// ---- Sunucudan gelen mesajlar ----
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

function updateRoomList(rooms) {
  const listDiv = document.getElementById('room-list');
  listDiv.innerHTML = rooms.map(r => 
    `<div style="padding:4px; cursor:pointer;" onclick="document.getElementById('join-room-name').value='${r.name}'; document.getElementById('join-form').style.display='flex'; menuDiv.style.display='none';">
      ${r.name} (${r.players}/${r.maxPlayers}) - ${r.map} ${r.hasPassword?'🔒':''}
    </div>`
  ).join('');
}

// ---- Oyun durumu güncelleme ----
function updateGameState(state) {
  if (!scene) initScene(state.map); // haritayı ilk kez kur
  gameState = state;
  myPlayerId = state.myId;
  
  // UI güncelle
  gameUI.style.display = 'block';
  statusText.innerText = state.state === 'lobby' ? 'Lobide bekleniyor...' : 
                         state.state === 'preparing' ? 'Hazırlanma aşaması' :
                         state.state === 'seeking' ? 'Arama aşaması' : '';
  timerDiv.innerText = state.timeLeft ? `Süre: ${state.timeLeft}s` : '';
  scoresDiv.innerText = Object.entries(state.scores).map(([id, sc]) => `Oyuncu ${id.slice(0,4)}: ${sc}`).join(' | ');
  
  const me = state.players.find(p => p.id === myPlayerId);
  if (me) {
    myColor = me.color;
    frozen = me.frozen;
    // Buton görünürlüğü
    if (me.role === 'hider' && state.state === 'preparing') {
      hiderButtons.style.display = 'flex';
      seekerButtons.style.display = 'none';
      if (frozen) {
        document.getElementById('btn-pipette').disabled = true;
        document.getElementById('btn-freeze').disabled = true;
      } else {
        document.getElementById('btn-pipette').disabled = false;
        document.getElementById('btn-freeze').disabled = false;
      }
    } else if (me.role === 'seeker' && state.state === 'seeking') {
      hiderButtons.style.display = 'none';
      seekerButtons.style.display = 'flex';
    } else {
      hiderButtons.style.display = 'none';
      seekerButtons.style.display = 'none';
    }
    
    // Figürümü güncelle
    myFigure.position.set(me.x, 0.7, me.z);
    myFigure.material.color.set(me.color);
  }
  
  // Uzak oyuncuları güncelle
  const existingIds = new Set(Object.keys(remoteFigures));
  state.players.forEach(p => {
    if (p.id === myPlayerId) return;
    existingIds.delete(p.id);
    if (!remoteFigures[p.id]) {
      const mat = new THREE.MeshStandardMaterial({ color: p.color });
      const geo = new THREE.CapsuleGeometry(0.4, 0.6, 2, 8);
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
  // Silinmiş oyuncuları kaldır
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

// ---- Three.js sahne kurulumu ----
function initScene(mapType) {
  if (scene) {
    // önceki sahneyi temizle
    while(scene.children.length > 0) scene.remove(scene.children[0]);
    renderer.dispose();
    document.body.removeChild(renderer.domElement);
  }
  
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.Fog(0x87CEEB, 10, 40);
  
  camera = new THREE.PerspectiveCamera(55, window.innerWidth/window.innerHeight, 0.1, 100);
  camera.position.set(0, 10, 10);
  
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);
  
  // Işık
  const ambient = new THREE.AmbientLight(0x445566);
  scene.add(ambient);
  const dirLight = new THREE.DirectionalLight(0xffeedd, 1);
  dirLight.position.set(10, 20, 5);
  dirLight.castShadow = true;
  dirLight.receiveShadow = true;
  scene.add(dirLight);
  
  // Zemin
  const groundGeo = new THREE.PlaneGeometry(20, 20);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x556B2F });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI/2;
  ground.receiveShadow = true;
  scene.add(ground);
  
  // Harita objeleri (renk pipeti için)
  mapObjects = [];
  const mapData = {
    minecraft: [
      { type: 'box', size: [1,1,1], pos: [0,0.5,0], color: 0x8B4513 },
      { type: 'box', size: [2,1,2], pos: [-2,0.5,2], color: 0x228B22 },
      { type: 'box', size: [0.8,1.5,0.8], pos: [2.5,0.75,-1], color: 0xFFD700 },
      { type: 'sphere', radius: 0.6, pos: [-2.5,0.6,-2], color: 0xFF4500 },
      { type: 'cylinder', radiusTop:0.4, radiusBottom:0.4, height:1.2, pos: [0,0.6,2.5], color: 0x4B0082 }
    ],
    ev: [
      { type: 'box', size: [0.5,0.8,0.5], pos: [0.5,0.4,1], color: 0x8B0000 },
      { type: 'box', size: [1,0.3,1.5], pos: [-1.5,0.15,0], color: 0x5C4033 },
      { type: 'cylinder', radiusTop:0.3, radiusBottom:0.3, height:1.5, pos: [1.2,0.75,-1], color: 0x708090 },
      { type: 'sphere', radius:0.5, pos: [-0.8,0.5,-1.8], color: 0xFF69B4 },
      { type: 'box', size: [1.2,0.6,0.6], pos: [2,0.3,1.5], color: 0x556B2F }
    ]
  }[mapType] || [];
  
  mapData.forEach(obj => {
    let mesh;
    switch(obj.type) {
      case 'box': mesh = new THREE.Mesh(new THREE.BoxGeometry(...obj.size), new THREE.MeshStandardMaterial({color: obj.color})); break;
      case 'sphere': mesh = new THREE.Mesh(new THREE.SphereGeometry(obj.radius), new THREE.MeshStandardMaterial({color: obj.color})); break;
      case 'cylinder': mesh = new THREE.Mesh(new THREE.CylinderGeometry(obj.radiusTop, obj.radiusBottom, obj.height), new THREE.MeshStandardMaterial({color: obj.color})); break;
    }
    mesh.position.set(obj.pos[0], obj.pos[1], obj.pos[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { color: obj.color };
    scene.add(mesh);
    mapObjects.push(mesh);
  });
  
  // Kendi figürüm
  myFigure = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.4, 0.6, 2, 8),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  myFigure.castShadow = true;
  myFigure.receiveShadow = true;
  myFigure.position.y = 0.7;
  scene.add(myFigure);
  
  remoteFigures = {};
  
  // Animasyon döngüsünü başlat
  animate();
}

// ---- Hareket (klavye + joystick) ----
const keyState = { w:false, a:false, s:false, d:false };
window.addEventListener('keydown', e => {
  switch(e.key.toLowerCase()) {
    case 'w': keyState.w=true; e.preventDefault(); break;
    case 'a': keyState.a=true; e.preventDefault(); break;
    case 's': keyState.s=true; e.preventDefault(); break;
    case 'd': keyState.d=true; e.preventDefault(); break;
  }
});
window.addEventListener('keyup', e => {
  switch(e.key.toLowerCase()) {
    case 'w': keyState.w=false; e.preventDefault(); break;
    case 'a': keyState.a=false; e.preventDefault(); break;
    case 's': keyState.s=false; e.preventDefault(); break;
    case 'd': keyState.d=false; e.preventDefault(); break;
  }
});

// Joystick dokunmatik
const jBase = document.getElementById('joystick-base');
const jThumb = document.getElementById('joystick-thumb');
let jActive = false, jVec = { x:0, z:0 };
jBase.addEventListener('touchstart', e => { e.preventDefault(); jActive=true; });
jBase.addEventListener('touchmove', e => {
  e.preventDefault();
  if(!jActive) return;
  const touch = e.touches[0];
  const rect = jBase.getBoundingClientRect();
  const cx = rect.left+rect.width/2, cy = rect.top+rect.height/2;
  let dx = touch.clientX - cx, dy = touch.clientY - cy;
  const maxR = 40, dist = Math.sqrt(dx*dx+dy*dy);
  if(dist > maxR) { dx *= maxR/dist; dy *= maxR/dist; }
  jThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  jVec.x = dx/maxR;
  jVec.z = dy/maxR;
});
jBase.addEventListener('touchend', e => {
  e.preventDefault(); jActive=false;
  jThumb.style.transform = 'translate(-50%, -50%)';
  jVec.x=0; jVec.z=0;
});

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
    const len = Math.sqrt(dx*dx+dz*dz);
    dx /= len; dz /= len;
    const speed = 0.12;
    myFigure.position.x += dx * speed;
    myFigure.position.z += dz * speed;
    // sınırlar
    const lim = 8;
    myFigure.position.x = Math.max(-lim, Math.min(lim, myFigure.position.x));
    myFigure.position.z = Math.max(-lim, Math.min(lim, myFigure.position.z));
    ws.send(JSON.stringify({ type: 'move', x: myFigure.position.x, z: myFigure.position.z }));
  }
}

// ---- Buton işlevleri ----
document.getElementById('btn-pipette').onclick = () => {
  if (!myFigure || frozen) return;
  const pos = myFigure.position;
  let closestDist = 1.8;
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

// ---- Animasyon ----
function animate() {
  requestAnimationFrame(animate);
  handleMovement();
  if (camera && myFigure) {
    const target = myFigure.position;
    camera.position.lerp(new THREE.Vector3(target.x, target.y+7, target.z+7), 0.1);
    camera.lookAt(target);
  }
  if (renderer && scene && camera) renderer.render(scene, camera);
}

// Pencere boyutu
window.addEventListener('resize', () => {
  if (camera) {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
});