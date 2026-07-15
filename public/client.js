import * as THREE from 'three';

// ---------- Bağlantı ----------
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${protocol}://${location.host}`;
let ws;
let myRole = null; // 'hider' | 'seeker'
let myColor = 0xffffff;
let frozen = false;
let phase = 'waiting'; // waiting | preparing | seeking
let timeLeft = 0;

function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => setStatus('Bağlandı, rakip bekleniyor...');
  ws.onmessage = handleMessage;
  ws.onclose = () => { setStatus('Bağlantı koptu'); setTimeout(connect, 2000); };
}
connect();

function setStatus(text) { document.getElementById('status').innerText = text; }
function setRoleInfo(text) { document.getElementById('role-info').innerText = text; }
function setTimer(text) { document.getElementById('timer').innerText = text; }
function setScores(text) { document.getElementById('scores').innerText = text; }
function setMessage(text) { document.getElementById('message').innerText = text; }

// ---------- Three.js Sahne ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);
scene.fog = new THREE.Fog(0x87CEEB, 15, 35);
const camera = new THREE.PerspectiveCamera(55, window.innerWidth/window.innerHeight, 0.1, 100);
camera.position.set(0, 12, 12);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// Işık
scene.add(new THREE.AmbientLight(0x445566));
const dirLight = new THREE.DirectionalLight(0xffeedd, 1);
dirLight.position.set(10, 20, 5);
dirLight.castShadow = true;
dirLight.receiveShadow = true;
scene.add(dirLight);

// Zemin
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ color: 0x445544 })
);
ground.rotation.x = -Math.PI/2;
ground.receiveShadow = true;
scene.add(ground);

// Renkli objeler (duvarlar, kutular) – pipetle renk almak için
const colorObjects = [];
function createColorObjects() {
  const geometries = [
    { geo: new THREE.BoxGeometry(0.8, 1.5, 0.8), pos: [3, 0.75, 0], col: 0xff3333 },
    { geo: new THREE.BoxGeometry(0.8, 1.2, 0.8), pos: [-3, 0.6, 1], col: 0x33ff33 },
    { geo: new THREE.CylinderGeometry(0.4, 0.4, 1.5), pos: [0, 0.75, 3], col: 0x3333ff },
    { geo: new THREE.SphereGeometry(0.6), pos: [-2, 0.6, -2], col: 0xffaa00 },
    { geo: new THREE.BoxGeometry(1, 0.8, 1), pos: [2, 0.4, -3], col: 0xff00ff },
    { geo: new THREE.ConeGeometry(0.5, 1.2), pos: [-1, 0.6, -3], col: 0x00ffff },
    { geo: new THREE.BoxGeometry(0.5, 0.5, 0.5), pos: [0, 0.25, -2], col: 0xffffff },
  ];
  geometries.forEach(g => {
    const mesh = new THREE.Mesh(g.geo, new THREE.MeshStandardMaterial({ color: g.col }));
    mesh.position.set(g.pos[0], g.pos[1], g.pos[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { color: g.col };
    scene.add(mesh);
    colorObjects.push(mesh);
  });
}
createColorObjects();

// Oyuncu figürleri
const myFigure = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.4, 0.6, 2, 8),
  new THREE.MeshStandardMaterial({ color: 0xffffff })
);
myFigure.castShadow = true;
myFigure.receiveShadow = true;
myFigure.position.y = 0.7;
scene.add(myFigure);

const remoteFigure = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.4, 0.6, 2, 8),
  new THREE.MeshStandardMaterial({ color: 0xffffff })
);
remoteFigure.castShadow = true;
remoteFigure.receiveShadow = true;
remoteFigure.position.y = 0.7;
remoteFigure.visible = false;
scene.add(remoteFigure);

// Kamera takip
function updateCamera() {
  const target = myFigure.position.clone();
  camera.position.lerp(new THREE.Vector3(target.x, target.y+8, target.z+7), 0.1);
  camera.lookAt(target);
}

// ---------- Mesaj işleme ----------
function handleMessage(event) {
  const msg = JSON.parse(event.data);
  switch(msg.type) {
    case 'waiting':
      setStatus('Rakip bekleniyor...');
      break;
    case 'roomAssigned':
      myRole = msg.role;
      setStatus('Odaya katıldın!');
      setRoleInfo(`Rol: ${myRole === 'hider' ? '🎭 Saklanan' : '🔎 Ebe'}`);
      updateUIForRole();
      break;
    case 'phase':
      phase = msg.phase;
      if (msg.phase === 'preparing') {
        setStatus('Hazırlık aşaması – Saklanan kendini gizlesin!');
        if (myRole === 'hider') {
          frozen = false;
          setMessage('Renk seç ve Don!');
        } else {
          setMessage('Saklanan hazırlanıyor...');
        }
      } else if (msg.phase === 'seeking') {
        setStatus('🔎 Ebe arıyor!');
        setTimer(`Süre: ${msg.timeLeft || ROUND_DURATION}s`);
        if (myRole === 'seeker') setMessage('Yakala!');
        else setMessage('Saklan!');
      }
      updateUIForRole();
      break;
    case 'state':
      updateState(msg.players, msg.timeLeft);
      break;
    case 'roundEnd':
      setMessage(msg.caught ? 'Yakalandın! 🎯' : 'Kurtuldun! 🎉');
      setScores(`Skor: Saklanan ${msg.scores.hider} - Ebe ${msg.scores.seeker}`);
      break;
    case 'catchFail':
      setMessage(msg.message);
      setTimeout(() => setMessage(''), 1500);
      break;
    case 'opponentLeft':
      setStatus('Rakip ayrıldı, sayfayı yenile.');
      break;
  }
}

function updateState(players, tLeft) {
  timeLeft = tLeft;
  if (phase === 'seeking') setTimer(`Süre: ${timeLeft}s`);
  players.forEach(p => {
    if (p.role === myRole) {
      // Kendi figürüm
      myFigure.position.x = p.x;
      myFigure.position.z = p.z;
      myFigure.material.color.set(p.color);
      myColor = p.color;
      frozen = p.frozen;
    } else {
      // Rakip figürü
      remoteFigure.position.x = p.x;
      remoteFigure.position.z = p.z;
      remoteFigure.material.color.set(p.color);
      remoteFigure.visible = true;
      // Ebe isek ve seeking fazındaysak rakip rengini gizle (beyaz göster) – saklananın rengini görmek hile olur
      if (myRole === 'seeker' && phase === 'seeking') {
        remoteFigure.material.color.set(0xffffff);
      }
    }
  });
}

function updateUIForRole() {
  document.getElementById('pipette-btn').style.display = (myRole === 'hider' && phase === 'preparing') ? 'flex' : 'none';
  document.getElementById('seeker-btn').style.display = (myRole === 'seeker' && phase === 'seeking') ? 'flex' : 'none';
}

// ---------- Hareket ve Joystick ----------
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

// Dokunmatik joystick
const joystickBase = document.getElementById('joystick-base');
const joystickThumb = document.getElementById('joystick-thumb');
let joystickActive = false, joystickVec = { x:0, z:0 };
joystickBase.addEventListener('touchstart', e => { e.preventDefault(); joystickActive=true; });
joystickBase.addEventListener('touchmove', e => {
  e.preventDefault();
  if(!joystickActive) return;
  const touch = e.touches[0];
  const rect = joystickBase.getBoundingClientRect();
  const cx = rect.left+rect.width/2, cy = rect.top+rect.height/2;
  let dx = touch.clientX - cx, dy = touch.clientY - cy;
  const maxR = 40, dist = Math.sqrt(dx*dx+dy*dy);
  if(dist > maxR) { dx *= maxR/dist; dy *= maxR/dist; }
  joystickThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  joystickVec.x = dx/maxR;
  joystickVec.z = dy/maxR;
});
joystickBase.addEventListener('touchend', e => {
  e.preventDefault(); joystickActive=false;
  joystickThumb.style.transform = 'translate(-50%, -50%)';
  joystickVec.x=0; joystickVec.z=0;
});

// Hareket fonksiyonu
function handleMovement() {
  let dx = 0, dz = 0;
  if (keyState.w) dz -= 1;
  if (keyState.s) dz += 1;
  if (keyState.a) dx -= 1;
  if (keyState.d) dx += 1;
  dx += joystickVec.x;
  dz += joystickVec.z;
  if (dx !== 0 || dz !== 0) {
    const len = Math.sqrt(dx*dx+dz*dz);
    dx /= len; dz /= len;
    const speed = 0.12;
    myFigure.position.x += dx * speed;
    myFigure.position.z += dz * speed;
    // sınırlar
    const lim = 7.5;
    myFigure.position.x = Math.max(-lim, Math.min(lim, myFigure.position.x));
    myFigure.position.z = Math.max(-lim, Math.min(lim, myFigure.position.z));
    sendMove();
  }
}

let lastSend = 0;
function sendMove() {
  const now = Date.now();
  if (now - lastSend > 50 && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'move',
      x: myFigure.position.x,
      z: myFigure.position.z
    }));
    lastSend = now;
  }
}

// ---------- Butonlar ----------
document.getElementById('btn-pipette').addEventListener('click', () => {
  if (myRole !== 'hider' || frozen) return;
  // Etraftaki en yakın renk objesini bul
  let closestDist = 2.0;
  let pickedColor = null;
  const myPos = myFigure.position;
  colorObjects.forEach(obj => {
    const dist = myPos.distanceTo(obj.position);
    if (dist < closestDist) {
      closestDist = dist;
      pickedColor = obj.userData.color;
    }
  });
  if (pickedColor !== null) {
    myColor = pickedColor;
    myFigure.material.color.set(pickedColor);
    ws.send(JSON.stringify({ type: 'color', color: pickedColor }));
    setMessage(`Renk alındı! #${pickedColor.toString(16)}`);
  } else {
    setMessage('Yakında renk yok!');
  }
  setTimeout(() => setMessage(''), 1500);
});

document.getElementById('btn-freeze').addEventListener('click', () => {
  if (myRole !== 'hider' || frozen) return;
  frozen = true;
  ws.send(JSON.stringify({ type: 'freeze' }));
  setMessage('Dondun! Saklanma başlıyor...');
  document.getElementById('pipette-btn').style.display = 'none';
});

document.getElementById('btn-catch').addEventListener('click', () => {
  if (myRole !== 'seeker' || phase !== 'seeking') return;
  ws.send(JSON.stringify({ type: 'catch' }));
});

// ---------- Animasyon döngüsü ----------
function animate() {
  requestAnimationFrame(animate);
  handleMovement();
  updateCamera();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
