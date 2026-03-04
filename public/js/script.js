// ─── Constants ─────────────────────────────────────────────────────
const AVG_SPEED_KMPH = 30;
const LOCATION_UPDATE_INTERVAL = 2000;
const HEARTBEAT_INTERVAL = 15000;

// ─── State ───────────────────────────────────────────────────────────────────
let myRoomId = null;
let myRole = null;
let myLocation = null;
let partnerLocation = null;
let watchId = null;
let routingControl = null;
let heartbeatTimer = null;
let lastEmitTime = 0;
let isPartnerConnected = false;
let driverMarker = null;
let customerMarker = null;
let mapCenteredOnce = false;

// ─── DOM Elements ────────────────────────────────────────────────────────────
const etaMinutes = document.getElementById('eta-minutes');
const partnerStatusText = document.getElementById('partner-status-text');
const disconnectOverlay = document.getElementById('disconnect-overlay');
const disconnectMsg = document.getElementById('disconnect-msg');
const roleOverlay = document.getElementById('role-overlay');
const centerBtn = document.getElementById('center-btn');
const roomInput = document.getElementById('room-input');
const errorText = document.getElementById('error-text');

// ─── Initialize Map ──────────────────────────────────────────────────────────
const map = L.map('map', {
    zoomControl: false,
    attributionControl: false
}).setView([0, 0], 16);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; CartoDB'
}).addTo(map);

// Force resize multiple times to ensure visibility
setTimeout(() => { map.invalidateSize(); }, 500);
setTimeout(() => { map.invalidateSize(); }, 2000);

// ─── Socket.IO Setup ──────────────────────────────────────────────────────────
const socket = io();

// ─── Socket Events ────────────────────────────────────────────────────────────

socket.on('connect', () => {
    console.log('[Socket] Connected:', socket.id);
    if (myRoomId && myRole) {
        socket.emit('join-room', { roomId: myRoomId, role: myRole });
    }
    startHeartbeat();
    if (partnerStatusText) partnerStatusText.textContent = "Connected";
});

socket.on('error-msg', (data) => {
    if (errorText) {
        errorText.textContent = data.message;
        errorText.classList.remove('hidden');
    }
    roleOverlay.style.display = 'flex';
    myRole = null;
    myRoomId = null;
});

socket.on('partner-connected', (data) => {
    console.log('[Socket] Partner connected:', data.role);
    isPartnerConnected = true;
    if (partnerStatusText) partnerStatusText.textContent = `${data.role} joined the room`;
    if (disconnectOverlay) disconnectOverlay.classList.add('hidden');
});

socket.on('partner-disconnected', (data) => {
    console.log('[Socket] Partner disconnected:', data.role);
    isPartnerConnected = false;
    if (partnerStatusText) partnerStatusText.textContent = `${data.role} left the room`;

    if (disconnectOverlay) {
        disconnectMsg.textContent = `${data.role === 'driver' ? 'Driver' : 'Customer'} disconnected. Waiting to reconnect...`;
        disconnectOverlay.classList.remove('hidden');
    }

    if (data.role === 'driver' && driverMarker) {
        map.removeLayer(driverMarker);
        driverMarker = null;
    } else if (data.role === 'customer' && customerMarker) {
        map.removeLayer(customerMarker);
        customerMarker = null;
    }
    removeRoutingControl();
    if (etaMinutes) etaMinutes.textContent = '--';
});

socket.on('receive-location', (data) => {
    const { role, latitude, longitude, heading, speed } = data;

    if (role === 'driver') {
        updateDriverMarker(latitude, longitude);
        if (myRole === 'customer') {
            partnerLocation = { latitude, longitude, speed };
        }
    } else if (role === 'customer') {
        updateCustomerMarker(latitude, longitude);
        if (myRole === 'driver') {
            partnerLocation = { latitude, longitude };
        }
    }

    if (myLocation && partnerLocation) {
        const dPos = myRole === 'driver' ? myLocation : partnerLocation;
        const cPos = myRole === 'customer' ? myLocation : partnerLocation;
        updateRoute(dPos, cPos);
    }
});

// ─── Room Join Logic ──────────────────────────────────────────────────────────

function joinRoom(role, ridFromUrl = null) {
    const rid = ridFromUrl || roomInput.value.trim();
    if (!rid) {
        errorText.textContent = "Please enter a Tracking ID";
        errorText.classList.remove('hidden');
        return;
    }

    myRoomId = rid;
    myRole = role;
    roleOverlay.style.display = 'none';

    socket.emit('join-room', { roomId: rid, role: role });
    startLocationTracking();
    console.log('[App] Joined room:', rid, 'as', role);
}

// ─── Geolocation Tracking ─────────────────────────────────────────────────────

function startLocationTracking() {
    if (!navigator.geolocation) return;

    if (watchId) navigator.geolocation.clearWatch(watchId);

    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const { latitude, longitude, accuracy, heading, speed } = pos.coords;
            const now = Date.now();
            myLocation = { latitude, longitude, accuracy, heading, speed };

            if (myRole === 'driver') updateDriverMarker(latitude, longitude);
            else updateCustomerMarker(latitude, longitude);

            if (!mapCenteredOnce) {
                map.setView([latitude, longitude], 16);
                mapCenteredOnce = true;
            }

            if (now - lastEmitTime >= LOCATION_UPDATE_INTERVAL) {
                socket.emit('send-location', { latitude, longitude, accuracy, heading, speed });
                lastEmitTime = now;
            }

            if (partnerLocation) {
                const dPos = myRole === 'driver' ? myLocation : partnerLocation;
                const cPos = myRole === 'customer' ? myLocation : partnerLocation;
                updateRoute(dPos, cPos);
            }
        },
        (err) => console.warn('[Geo] Error:', err),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

// ─── Marker Updates (Standard Markers) ───────────────────────────────────────

function updateDriverMarker(lat, lng) {
    if (driverMarker) {
        driverMarker.setLatLng([lat, lng]);
    } else {
        driverMarker = L.marker([lat, lng], { title: "Driver" }).addTo(map);
        driverMarker.bindPopup("Driver Location").openPopup();
    }
}

function updateCustomerMarker(lat, lng) {
    if (customerMarker) {
        customerMarker.setLatLng([lat, lng]);
    } else {
        customerMarker = L.marker([lat, lng], { title: "Customer" }).addTo(map);
        customerMarker.bindPopup("Destination").openPopup();
    }
}

// ─── Routing ──────────────────────────────────────────────────────────────────

function updateRoute(driverPos, customerPos) {
    const from = L.latLng(driverPos.latitude, driverPos.longitude);
    const to = L.latLng(customerPos.latitude, customerPos.longitude);

    if (routingControl) {
        routingControl.setWaypoints([from, to]);
    } else {
        routingControl = L.Routing.control({
            waypoints: [from, to],
            addWaypoints: false,
            draggableWaypoints: false,
            fitSelectedRoutes: false,
            show: false,
            createMarker: () => null,
            lineOptions: {
                styles: [{ color: '#4285F4', weight: 6, opacity: 0.8 }]
            },
            router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1' })
        }).addTo(map);

        routingControl.on('routesfound', (e) => {
            const totalTimeMins = Math.round(e.routes[0].summary.totalTime / 60);
            if (etaMinutes) etaMinutes.textContent = totalTimeMins < 1 ? '<1' : totalTimeMins.toString();
        });
    }
}

function removeRoutingControl() {
    if (routingControl) {
        map.removeControl(routingControl);
        routingControl = null;
    }
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
        if (socket.connected) socket.emit('heartbeat');
    }, HEARTBEAT_INTERVAL);
}

// ─── Center Map ───────────────────────────────────────────────────────────────

centerBtn.addEventListener('click', () => {
    if (myLocation && partnerLocation) {
        const bounds = L.latLngBounds([myLocation.latitude, myLocation.longitude], [partnerLocation.latitude, partnerLocation.longitude]);
        map.fitBounds(bounds, { padding: [100, 100] });
    } else if (myLocation) {
        map.setView([myLocation.latitude, myLocation.longitude], 16);
    }
});

// ─── Online/Offline Detection ─────────────────────────────────────────────────

window.addEventListener('online', () => {
    if (socket.disconnected) socket.connect();
});

window.addEventListener('offline', () => {
    if (partnerStatusText) partnerStatusText.textContent = "Offline";
});

// ─── Init ─────────────────────────────────────────────────────────────────────

window.onload = () => {
    map.invalidateSize();

    // Auto-join from URL if params exist
    const params = new URLSearchParams(window.location.search);
    const rid = params.get('room');
    const role = params.get('role');
    if (rid && role) {
        roomInput.value = rid;
        joinRoom(role, rid);
    }
};
