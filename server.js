const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Render veya yerel port ayarı
const PORT = process.env.PORT || 3000;

// Statik dosyalar için 'public' klasörünü kullan
app.use(express.static(path.join(__dirname, 'public')));

// Aktif oyuncuların listesi
const players = {};

// Harita üzerindeki arka plan nesneleri (Odalar/Bölgeler)
// Oyuncular bu nesnelerin önüne geçip renklerini uydurmaya çalışacaklar
const mapObjects = [
    { id: "wall_red", x: 100, y: 100, width: 200, height: 150, color: "#ff4d4d", name: "Kırmızı Tuğla Duvar" },
    { id: "wall_blue", x: 400, y: 100, width: 200, height: 150, color: "#3399ff", name: "Mavi Duvar Kağıdı" },
    { id: "floor_tiles", x: 100, y: 350, width: 250, height: 200, color: "#e6e6e6", name: "Mutfak Fayansı" },
    { id: "countertop", x: 450, y: 350, width: 250, height: 200, color: "#808080", name: "Metal Tezgah" }
];

io.on('connection', (socket) => {
    console.log(`Yeni oyuncu bağlandı: ${socket.id}`);

    // Yeni bağlanan oyuncuyu rastgele bir konumda ve varsayılan renklerle başlat
    players[socket.id] = {
        id: socket.id,
        x: 350,
        y: 300,
        radius: 20,
        speed: 4,
        // Karakterin manuel boyanabilir 3 bölgesi: gövde, kollar, şapka/kafa
        colors: {
            body: "#ffffff",
            limbs: "#ffffff",
            head: "#ffffff"
        },
        nickname: `Oyuncu_${socket.id.substring(0, 4)}`
    };

    // Bağlanan oyuncuya mevcut harita nesnelerini ve diğer oyuncuları gönder
    socket.emit('init', {
        id: socket.id,
        mapObjects: mapObjects,
        players: players
    });

    // Diğer oyunculara yeni birinin geldiğini bildir
    socket.broadcast.emit('newPlayer', players[socket.id]);

    // Oyuncu hareket verisi senkronizasyonu
    socket.on('move', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            // Tüm istemcilere bu oyuncunun hareketini ilet
            socket.broadcast.emit('playerMoved', {
                id: socket.id,
                x: players[socket.id].x,
                y: players[socket.id].y
            });
        }
    });

    // Manuel Renk Değişimi / Kamuflaj Senkronizasyonu
    // Oyuncu damlalık veya paletle bir bölgesini boyadığında burası tetiklenir
    socket.on('updateColors', (colorData) => {
        if (players[socket.id]) {
            players[socket.id].colors = {
                body: colorData.body,
                limbs: colorData.limbs,
                head: colorData.head
            };
            // Yeni renkleri odadaki diğer tüm oyunculara anlık gönder
            io.emit('playerColorsUpdated', {
                id: socket.id,
                colors: players[socket.id].colors
            });
        }
    });

    // Bağlantı kesildiğinde oyuncuyu temizle
    socket.on('disconnect', () => {
        console.log(`Oyuncu ayrıldı: ${socket.id}`);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`OsColorMe sunucusu ${PORT} portunda aktif!`);
});
