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

const connectedUsers = {};
let driverSocketId = null;
let customerSocketId = null;

io.on("connection", function (socket) {

    socket.on("register-role", function (data) {
        const { role } = data;
        if (role !== 'driver' && role !== 'customer') return;

        if (role === 'driver') driverSocketId = socket.id;
        if (role === 'customer') customerSocketId = socket.id;

        connectedUsers[socket.id] = { role, latitude: null, longitude: null };

        const otherRole = role === 'driver' ? 'customer' : 'driver';
        const otherSocketId = role === 'driver' ? customerSocketId : driverSocketId;

        if (otherSocketId && connectedUsers[otherSocketId]) {
            socket.emit("partner-connected", { role: otherRole });
            io.to(otherSocketId).emit("partner-connected", { role });

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
    });

    socket.on("send-location", function (data) {
        const user = connectedUsers[socket.id];
        if (!user) return;

        user.latitude = data.latitude;
        user.longitude = data.longitude;
        user.accuracy = data.accuracy;
        user.heading = data.heading;
        user.speed = data.speed;

        const payload = {
            id: socket.id,
            role: user.role,
            latitude: data.latitude,
            longitude: data.longitude,
            accuracy: data.accuracy,
            heading: data.heading,
            speed: data.speed
        };

        const otherSocketId = user.role === 'driver' ? customerSocketId : driverSocketId;
        if (otherSocketId && connectedUsers[otherSocketId]) {
            io.to(otherSocketId).emit("receive-location", payload);
        }
    });

    socket.on("disconnect", function (reason) {
        const user = connectedUsers[socket.id];
        if (!user) return;

        const otherSocketId = user.role === 'driver' ? customerSocketId : driverSocketId;

        if (otherSocketId && connectedUsers[otherSocketId]) {
            io.to(otherSocketId).emit("partner-disconnected", { role: user.role });
        }

        delete connectedUsers[socket.id];
        if (user.role === 'driver') driverSocketId = null;
        if (user.role === 'customer') customerSocketId = null;
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
    console.log(`Tracker server running on http://localhost:${PORT}`);
});
