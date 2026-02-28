const express = require('express');
const app = express();
const http = require('http');
const path = require('path');
const socketio = require('socket.io');
const server = http.createServer(app);
const io = socketio(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});

app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

// Store connected users
// Structure: { socketId: { role: 'driver'|'customer', latitude, longitude, connectedAt } }
const connectedUsers = {};

// Track the active driver and customer socket IDs
let driverSocketId = null;
let customerSocketId = null;

io.on("connection", function (socket) {
    console.log(`[+] Socket connected: ${socket.id}`);

    // ─── Role Registration ────────────────────────────────────────────────
    socket.on("register-role", function (data) {
        const { role } = data;

        if (role !== 'driver' && role !== 'customer') return;

        // If a previous socket with same role existed, clean it up
        if (role === 'driver' && driverSocketId && driverSocketId !== socket.id) {
            console.log(`[~] Replacing old driver socket: ${driverSocketId}`);
            delete connectedUsers[driverSocketId];
        }
        if (role === 'customer' && customerSocketId && customerSocketId !== socket.id) {
            console.log(`[~] Replacing old customer socket: ${customerSocketId}`);
            delete connectedUsers[customerSocketId];
        }

        // Register this socket
        connectedUsers[socket.id] = { role, latitude: null, longitude: null, connectedAt: Date.now() };

        if (role === 'driver') driverSocketId = socket.id;
        if (role === 'customer') customerSocketId = socket.id;

        console.log(`[R] ${role} registered: ${socket.id}`);

        // If the other party is already connected, notify both about each other's presence
        const otherRole = role === 'driver' ? 'customer' : 'driver';
        const otherSocketId = role === 'driver' ? customerSocketId : driverSocketId;

        if (otherSocketId && connectedUsers[otherSocketId]) {
            // Tell the newly connected party about the other
            socket.emit("partner-connected", { role: otherRole });

            // Tell the existing party about the new connection
            io.to(otherSocketId).emit("partner-connected", { role });

            // If the other party already has location, send it to the newcomer
            const other = connectedUsers[otherSocketId];
            if (other.latitude !== null) {
                socket.emit("receive-location", {
                    id: otherSocketId,
                    role: other.role,
                    latitude: other.latitude,
                    longitude: other.longitude
                });
            }
        }

        // Acknowledge the registration to the client
        socket.emit("role-registered", { role, socketId: socket.id });
    });

    // ─── Location Update ──────────────────────────────────────────────────
    socket.on("send-location", function (data) {
        const user = connectedUsers[socket.id];
        if (!user) return;

        // Update stored location
        user.latitude = data.latitude;
        user.longitude = data.longitude;
        user.accuracy = data.accuracy;
        user.heading = data.heading;
        user.speed = data.speed;
        user.timestamp = Date.now();

        const payload = {
            id: socket.id,
            role: user.role,
            latitude: data.latitude,
            longitude: data.longitude,
            accuracy: data.accuracy,
            heading: data.heading,
            speed: data.speed
        };

        // Send to the opposite party only
        if (user.role === 'driver' && customerSocketId && connectedUsers[customerSocketId]) {
            io.to(customerSocketId).emit("receive-location", payload);
        } else if (user.role === 'customer' && driverSocketId && connectedUsers[driverSocketId]) {
            io.to(driverSocketId).emit("receive-location", payload);
        }

        // Also send back to sender so they can update their own UI indicator
        socket.emit("location-ack", { timestamp: user.timestamp });
    });

    // ─── Disconnect Handling ──────────────────────────────────────────────
    socket.on("disconnect", function (reason) {
        const user = connectedUsers[socket.id];
        if (!user) return;

        console.log(`[-] ${user.role} disconnected (${socket.id}): ${reason}`);

        const otherSocketId = user.role === 'driver' ? customerSocketId : driverSocketId;

        // Notify the partner
        if (otherSocketId && connectedUsers[otherSocketId]) {
            io.to(otherSocketId).emit("partner-disconnected", { role: user.role, reason });
        }

        // Clean up
        delete connectedUsers[socket.id];
        if (user.role === 'driver') driverSocketId = null;
        if (user.role === 'customer') customerSocketId = null;
    });

    // ─── Heartbeat / Status ───────────────────────────────────────────────
    socket.on("heartbeat", function () {
        if (connectedUsers[socket.id]) {
            connectedUsers[socket.id].lastHeartbeat = Date.now();
        }
        socket.emit("heartbeat-ack");
    });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", function (req, res) {
    res.render("index");
});

// Status endpoint for debugging
app.get("/status", function (req, res) {
    res.json({
        connectedUsers: Object.keys(connectedUsers).length,
        driver: driverSocketId ? { socketId: driverSocketId, ...connectedUsers[driverSocketId] } : null,
        customer: customerSocketId ? { socketId: customerSocketId, ...connectedUsers[customerSocketId] } : null
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(` Blinkit Tracker server running on http://localhost:${PORT}`);
    console.log(`   Driver URL  : http://localhost:${PORT}/?role=driver`);
    console.log(`   Customer URL: http://localhost:${PORT}/?role=customer`);
});
