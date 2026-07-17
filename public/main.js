const socket = io();

// Three.js Kurulum Değişkenleri
let scene, camera, renderer;
let myId = null;
const remotePlayers = {};
let localPlayerData = { x: 0, z: 0, colors: { head: '#ffffff', body: '#ffffff', legs: '#ffffff' } };
let my3DPlayer = null;

// Joystick Kontrol Değişkenleri
const joystickZone = document.getElementById('joystick-zone');
const joystickKnob = document.getElementById('joystick-knob');
let joystickActive = false;
let joystickStart = { x: 0, y: 0 };
let moveVector = { x: 0, z: 0 };
const moveSpeed = 0.15;

// Harita Sınırları ve Nesneleri Deposu
const localMapObjects = [];

// Sahneleri İlklendir
initThree();
setupJoystick();
setupColorPickers();
animate();

function initThree() {
    // 1. Sahne Oluşturma
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#1a1a1a');

    // 2. Kamera Ayarları
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 15, 12);
    camera.lookAt(0, 0, 2);

    // 3. Renderer Ayarları
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    document.getElementById('game-container').appendChild(renderer.domElement);

    // 4. Işıklandırmalar
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(10, 20, 10);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // 5. Zemin (Ana Alan)
    const floorGeo = new THREE.PlaneGeometry(40, 40);
    const floorMat = new THREE.MeshStandardMaterial({ color: '#2b2b2b', roughness: 0.8 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Pencere Boyutu Değişme Desteği
    window.addEventListener('resize', onWindowResize, false);
}

// 3D Karakter Tasarımı (Kafa, Gövde, Bacaklar - Manuel Boyanabilir Yapı)
function create3DPlayerModel(colors) {
    const playerGroup = new THREE.Group();

    // Kafa (Küre)
    const headGeo = new THREE.SphereGeometry(0.35, 16, 16);
    const headMat = new THREE.MeshStandardMaterial({ color: colors.head, roughness: 0.5 });
    const headMesh = new THREE.Mesh(headGeo, headMat);
    headMesh.position.y = 1.7;
    headMesh.castShadow = true;
    headMesh.name = "head";
    playerGroup.add(headMesh);

    // Gövde (Kutu)
    const bodyGeo = new THREE.BoxGeometry(0.7, 0.8, 0.4);
    const bodyMat = new THREE.MeshStandardMaterial({ color: colors.body, roughness: 0.5 });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.position.y = 1.0;
    bodyMesh.castShadow = true;
    bodyMesh.name = "body";
    playerGroup.add(bodyMesh);

    // Bacaklar (Silindir)
    const legsGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.6, 16);
    const legsMat = new THREE.MeshStandardMaterial({ color: colors.legs, roughness: 0.5 });
    const legsMesh = new THREE.Mesh(legsGeo, legsMat);
    legsMesh.position.y = 0.3;
    legsMesh.castShadow = true;
    legsMesh.name = "legs";
    playerGroup.add(legsMesh);

    return playerGroup;
}

// Sunucudan Gelen Sabit Nesneleri 3D Dünyaya Çizme Fonksiyonu
function build3DMapObjects(serverObjects) {
    serverObjects.forEach(obj => {
        // Sunucudaki 2D koordinatları 3D uzayına ölçekleyerek yerleştiriyoruz
        const width = obj.width / 50;
        const height = obj.height / 50;
        const depth = 2;

        const geo = new THREE.BoxGeometry(width, height, depth);
        const mat = new THREE.MeshStandardMaterial({ color: obj.color, roughness: 0.4 });
        const mesh = new THREE.Mesh(geo, mat);

        // Pozisyon eşitlemesi (Merkeze hizalama)
        mesh.position.set((obj.x / 25) - 10, height / 2, (obj.y / 25) - 10);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        localMapObjects.push(mesh);
    });
}

// --- NETWORK / SOCKET.IO İLETİŞİM ALANI ---

socket.on('init', (data) => {
    myId = data.id;
    
    // Sabit 3D harita elemanlarını oluştur
    build3DMapObjects(data.mapObjects);

    // Mevcut diğer oyuncuları odaya ekle
    Object.keys(data.players).forEach(id => {
        if (id === myId) {
            // Kendi 3D karakterimiz
            localPlayerData = data.players[id];
            // Koordinatları 3D düzleme çevir
            localPlayerData.x = 0;
            localPlayerData.z = 0;
            my3DPlayer = create3DPlayerModel(localPlayerData.colors);
            my3DPlayer.position.set(localPlayerData.x, 0, localPlayerData.z);
            scene.add(my3DPlayer);
        } else {
            // Diğer oyuncular
            const pData = data.players[id];
            const rX = (pData.x / 25) - 10;
            const rZ = (pData.y / 25) - 10;
            const remoteModel = create3DPlayerModel(pData.colors);
            remoteModel.position.set(rX, 0, rZ);
            scene.add(remoteModel);
            remotePlayers[id] = remoteModel;
        }
    });
});

socket.on('newPlayer', (pData) => {
    if (remotePlayers[pData.id]) return;
    const rX = (pData.x / 25) - 10;
    const rZ = (pData.y / 25) - 10;
    const remoteModel = create3DPlayerModel(pData.colors);
    remoteModel.position.set(rX, 0, rZ);
    scene.add(remoteModel);
    remotePlayers[pData.id] = remoteModel;
});

socket.on('playerMoved', (moveData) => {
    if (remotePlayers[moveData.id]) {
        const rX = (moveData.x / 25) - 10;
        const rZ = (moveData.y / 25) - 10;
        remotePlayers[moveData.id].position.set(rX, 0, rZ);
    }
});

socket.on('playerColorsUpdated', (colorData) => {
    let targetMeshGroup = null;

    if (colorData.id === myId) {
        targetMeshGroup = my3DPlayer;
    } else if (remotePlayers[colorData.id]) {
        targetMeshGroup = remotePlayers[colorData.id];
    }

    if (targetMeshGroup) {
        targetMeshGroup.children.forEach(child => {
            if (child.name === "head") child.material.color.set(colorData.colors.head);
            if (child.name === "body") child.material.color.set(colorData.colors.body);
            if (child.name === "legs") child.material.color.set(colorData.colors.legs);
        });
    }
});

socket.on('playerDisconnected', (id) => {
    if (remotePlayers[id]) {
        scene.remove(remotePlayers[id]);
        delete remotePlayers[id];
    }
});

// --- MOBİL MULTI-TOUCH JOYSTICK YÖNETİMİ ---

function setupJoystick() {
    joystickZone.addEventListener('touchstart', (e) => {
        joystickActive = true;
        const touch = e.touches[0];
        joystickStart = { x: touch.clientX, y: touch.clientY };
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
        if (!joystickActive) return;
        
        // Çoklu dokunmada joystick'e ait doğru touch'ı bulalım
        let targetTouch = null;
        for(let i=0; i<e.touches.length; i++) {
            if (e.touches[i].clientX < window.innerWidth / 2) {
                targetTouch = e.touches[i];
                break;
            }
        }
        if(!targetTouch) return;

        const deltaX = targetTouch.clientX - joystickStart.x;
        const deltaY = targetTouch.clientY - joystickStart.y;
        const distance = Math.min(Math.sqrt(deltaX * deltaX + deltaY * deltaY), 50);
        
        const angle = Math.atan2(deltaY, deltaX);
        const knobX = Math.cos(angle) * distance;
        const knobY = Math.sin(angle) * distance;

        joystickKnob.style.transform = `translate(${knobX}px, ${knobY}px)`;

        // Yön vektörlerini belirle (Three.js Z ve X eksenlerine ata)
        moveVector.x = Math.cos(angle) * (distance / 50);
        moveVector.z = Math.sin(angle) * (distance / 50);
    }, { passive: true });

    window.addEventListener('touchend', () => {
        joystickActive = false;
        joystickKnob.style.transform = 'translate(0px, 0px)';
        moveVector.x = 0;
        moveVector.z = 0;
    });
}

// --- MANUEL RENK SEÇİCİLER (EYE DROPPER / COLOR PICKER LOGIC) ---

function setupColorPickers() {
    const pickers = {
        head: document.getElementById('picker-head'),
        body: document.getElementById('picker-body'),
        legs: document.getElementById('picker-legs')
    };

    Object.keys(pickers).forEach(key => {
        pickers[key].addEventListener('input', (e) => {
            localPlayerData.colors[key] = e.target.value;
            
            // Yerelde anlık güncelle
            if (my3DPlayer) {
                my3DPlayer.children.forEach(child => {
                    if (child.name === key) {
                        child.material.color.set(e.target.value);
                    }
                });
            }

            // Değişen renk verisini sunucu üzerinden tüm online dünyaya aktar
            socket.emit('updateColors', localPlayerData.colors);
        });
    });
}

// Pencere Boyutu Senkronu
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- ANA OYUN DÖNGÜSÜ (RENDER LOOP) ---

function animate() {
    requestAnimationFrame(animate);

    // Eğer joystick aktifse karakteri hareket ettir ve sunucuya bildir
    if (joystickActive && my3DPlayer) {
        localPlayerData.x += moveVector.x * moveSpeed;
        localPlayerData.z += moveVector.z * moveSpeed;

        // Dünya sınırları kontrolü
        localPlayerData.x = Math.max(-19, Math.min(19, localPlayerData.x));
        localPlayerData.z = Math.max(-19, Math.min(19, localPlayerData.z));

        my3DPlayer.position.set(localPlayerData.x, 0, localPlayerData.z);

        // Sunucunun 2D sistemine koordinatları ölçekleyerek gönder
        socket.emit('move', {
            x: (localPlayerData.x + 10) * 25,
            y: (localPlayerData.z + 10) * 25
        });
    }

    renderer.render(scene, camera);
}
