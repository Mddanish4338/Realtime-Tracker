const express = require('express');
const app = express();
const http = require('http');
const path = require('path');
const socketio = require('socket.io');
const server = http.createServer(app);
const io = socketio(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000
});

app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

const rooms = {};

io.on("connection", function (socket) {
    console.log(`[+] Socket connected: ${socket.id}`);

    socket.on("join-room", function (data) {
        const { roomId, role } = data;
        if (!roomId || !role) return;

        socket.join(roomId);
        socket.roomId = roomId;
        socket.role = role;

        if (!rooms[roomId]) {
            rooms[roomId] = { driver: null, customer: null };
        }

        // Prevent multiple drivers/customers in the same room
        if (role === 'driver') {
            if (rooms[roomId].driver) {
                socket.emit("error-msg", { message: "Driver already in this room." });
                return;
            }
            rooms[roomId].driver = { id: socket.id, lat: null, lng: null };
        } else if (role === 'customer') {
            if (rooms[roomId].customer) {
                socket.emit("error-msg", { message: "Customer already in this room." });
                return;
            }
            rooms[roomId].customer = { id: socket.id, lat: null, lng: null };
        }

        console.log(`[R] ${role} joined room ${roomId}: ${socket.id}`);

        // Notify others in room
        socket.to(roomId).emit("partner-connected", { role });

        // If partner exists, notify the joiner
        const partnerRole = role === 'driver' ? 'customer' : 'driver';
        const partner = rooms[roomId][partnerRole];
        if (partner) {
            socket.emit("partner-connected", { role: partnerRole });
            if (partner.lat !== null) {
                socket.emit("receive-location", {
                    id: partner.id,
                    role: partnerRole,
                    latitude: partner.lat,
                    longitude: partner.lng
                });
            }
        }
    });

    socket.on("send-location", function (data) {
        const { roomId, role } = socket;
        if (!roomId || !role || !rooms[roomId]) return;

        const room = rooms[roomId];
        const me = room[role];
        if (!me) return;

        me.lat = data.latitude;
        me.lng = data.longitude;

        const payload = {
            id: socket.id,
            role: role,
            latitude: data.latitude,
            longitude: data.longitude,
            accuracy: data.accuracy,
            heading: data.heading,
            speed: data.speed
        };

        socket.to(roomId).emit("receive-location", payload);
    });

    socket.on("disconnect", function (reason) {
        const { roomId, role } = socket;
        if (roomId && role && rooms[roomId]) {
            console.log(`[-] ${role} left room ${roomId} (${socket.id})`);
            socket.to(roomId).emit("partner-disconnected", { role });
            rooms[roomId][role] = null;

            if (!rooms[roomId].driver && !rooms[roomId].customer) {
                delete rooms[roomId];
            }
        }
    });

    socket.on("heartbeat", function () {
        socket.emit("heartbeat-ack");
    });
});

app.get("/", function (req, res) {
    res.render("index");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Blinkit Tracker server running on http://localhost:${PORT}`);
});
