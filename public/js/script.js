/* ═══════════════════════════════════════════════════════════
   BLINKIT-STYLE LIVE TRACKER — script.js
   Handles: role detection, GPS, socket events, routing,
            distance calc, reconnection, UI updates
═══════════════════════════════════════════════════════════ */

// ─── Constants & Config ─────────────────────────────────────────────────────
const AVG_SPEED_KMPH = 30; // average speed for ETA when speed is unknown
const LOCATION_UPDATE_INTERVAL = 2000; // ms — max interval between location emits
const HEARTBEAT_INTERVAL = 15000; // ms

// ─── State ───────────────────────────────────────────────────────────────────
let myRole = null;          // 'driver' | 'customer'
let myLocation = null;      // { latitude, longitude }
let partnerLocation = null; // { latitude, longitude }
let watchId = null;         // geolocation watchPosition id
let routingControl = null;  // Leaflet Routing Machine control
let heartbeatTimer = null;
let lastEmitTime = 0;
let isPartnerConnected = false;
let driverMarker = null;
let customerMarker = null;
let accuracyCircle = null;
let mapCenteredOnce = false;

// ─── DOM Elements ────────────────────────────────────────────────────────────
const connectionDot = document.getElementById('connection-dot');
const connectionText = document.getElementById('connection-text');
const roleBadge = document.getElementById('role-badge');
const etaMinutes = document.getElementById('eta-minutes');
const distanceValue = document.getElementById('distance-value');
const speedValue = document.getElementById('speed-value');
const partnerStatusText = document.getElementById('partner-status-text');
const disconnectOverlay = document.getElementById('disconnect-overlay');
const disconnectMsg = document.getElementById('disconnect-msg');
const roleOverlay = document.getElementById('role-overlay');
const centerBtn = document.getElementById('center-btn');
const orderTitle = document.getElementById('order-title');
const orderSubtitle = document.getElementById('order-subtitle');
const orderIcon = document.getElementById('order-icon');

// ─── Initialize Map ──────────────────────────────────────────────────────────
const map = L.map('map', {
    zoomControl: true,
    attributionControl: false
}).setView([20.5937, 78.9629], 5); // Default: India center

// Modern tile layer (OpenStreetMap)
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Bring zoom controls to the right
map.zoomControl.setPosition('bottomright');

// ─── Custom Marker Icons ──────────────────────────────────────────────────────

function createDriverIcon(heading) {
    const rotation = heading !== null && heading !== undefined ? heading : 0;
    return L.divIcon({
        className: '',
        html: `<div style="
            font-size: 32px;
            transform: rotate(${rotation}deg);
            filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));
            transition: transform 0.4s ease;
            display: flex; align-items:center; justify-content:center;
            width:40px; height:40px;
        ">🏍️</div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 20],
        popupAnchor: [0, -20]
    });
}

function createCustomerIcon() {
    return L.divIcon({
        className: '',
        html: `<div style="
            display: flex; flex-direction: column; align-items: center;
        ">
            <div style="
                font-size: 30px;
                filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));
                animation: none;
            ">🏠</div>
            <div style="
                width: 0; height: 0;
                border-left: 5px solid transparent;
                border-right: 5px solid transparent;
                border-top: 8px solid #ff4444;
                margin-top: -2px;
            "></div>
        </div>`,
        iconSize: [40, 50],
        iconAnchor: [20, 50],
        popupAnchor: [0, -50]
    });
}

// ─── Socket.IO Setup ──────────────────────────────────────────────────────────
const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
});

// ─── Socket Events ────────────────────────────────────────────────────────────

socket.on('connect', () => {
    setConnectionStatus('connected', 'Connected');
    console.log('[Socket] Connected:', socket.id);

    // Re-register role on reconnect
    if (myRole) {
        socket.emit('register-role', { role: myRole });
    }

    // Restart heartbeat
    startHeartbeat();
});

socket.on('disconnect', (reason) => {
    setConnectionStatus('disconnected', 'Disconnected');
    console.log('[Socket] Disconnected:', reason);
    stopHeartbeat();
});

socket.on('connect_error', (err) => {
    setConnectionStatus('reconnecting', 'Reconnecting...');
    console.log('[Socket] Connect error:', err.message);
});

socket.on('reconnect_attempt', (n) => {
    setConnectionStatus('reconnecting', `Reconnecting (${n})...`);
});

socket.on('reconnect', () => {
    setConnectionStatus('connected', 'Reconnected');
    if (myRole) {
        socket.emit('register-role', { role: myRole });
    }
});

socket.on('role-registered', (data) => {
    console.log('[Socket] Role registered:', data);
});

socket.on('partner-connected', (data) => {
    console.log('[Socket] Partner connected:', data.role);
    isPartnerConnected = true;
    hideDisconnectOverlay();
    updatePartnerStatus(`${data.role === 'driver' ? '🏍️ Driver' : '🏠 Customer'} is connected`);
});

socket.on('partner-disconnected', (data) => {
    console.log('[Socket] Partner disconnected:', data.role);
    isPartnerConnected = false;
    showDisconnectOverlay(`${data.role === 'driver' ? 'Driver' : 'Customer'} disconnected. Waiting to reconnect...`);
    updatePartnerStatus(`Partner disconnected`);
    resetInfoPanel();

    // Remove partner marker when they disconnect
    if (data.role === 'driver' && driverMarker) {
        map.removeLayer(driverMarker);
        driverMarker = null;
    } else if (data.role === 'customer' && customerMarker) {
        map.removeLayer(customerMarker);
        customerMarker = null;
    }

    // Remove route
    removeRoutingControl();
});

socket.on('receive-location', (data) => {
    const { id, role, latitude, longitude, heading, speed } = data;

    if (role === 'driver') {
        partnerLocation = (myRole === 'customer') ? { latitude, longitude } : partnerLocation;
        myLocation = (myRole === 'driver') ? { latitude, longitude } : myLocation;

        updateDriverMarker(latitude, longitude, heading);
        if (myRole === 'customer') {
            partnerLocation = { latitude, longitude };
        }
    } else if (role === 'customer') {
        updateCustomerMarker(latitude, longitude);
        if (myRole === 'driver') {
            partnerLocation = { latitude, longitude };
        }
    }

    // Update route and distance if both locations are known
    const driverPos = (myRole === 'driver') ? myLocation : (role === 'driver' ? { latitude, longitude } : partnerLocation);
    const customerPos = (myRole === 'customer') ? myLocation : (role === 'customer' ? { latitude, longitude } : partnerLocation);

    if (driverPos && customerPos) {
        updateRouteAndDistance(driverPos, customerPos, speed);
    }

    // Update speed display
    if (role === 'driver' && speed !== null && speed !== undefined) {
        const kmph = (speed * 3.6).toFixed(0);
        speedValue.textContent = `${kmph} km/h`;
    }
});

socket.on('heartbeat-ack', () => {
    // heartbeat acknowledged — connection is alive
});

// ─── Role Selection ───────────────────────────────────────────────────────────

function selectRole(role) {
    myRole = role;
    roleOverlay.classList.add('hidden');

    roleBadge.textContent = role === 'driver' ? '🏍️ Driver' : '🏠 Customer';
    roleBadge.style.background = role === 'driver' ? '#f8c200' : '#1a1a2e';
    roleBadge.style.color = role === 'driver' ? '#333' : 'white';

    if (role === 'driver') {
        orderTitle.textContent = 'You are delivering';
        orderSubtitle.textContent = 'Your live location is being shared';
        orderIcon.textContent = '🏍️';
    } else {
        orderTitle.textContent = 'Order on the way';
        orderSubtitle.textContent = 'Your delivery partner is heading to you';
        orderIcon.textContent = '📦';
    }

    socket.emit('register-role', { role });
    startLocationTracking();
    console.log('[App] Role selected:', role);
}

// ─── Role Detection from URL ──────────────────────────────────────────────────

function initRole() {
    const params = new URLSearchParams(window.location.search);
    const roleFromURL = params.get('role');

    if (roleFromURL === 'driver' || roleFromURL === 'customer') {
        selectRole(roleFromURL);
    } else {
        // Show role selection overlay
        roleOverlay.classList.remove('hidden');
    }
}

// ─── Geolocation Tracking ─────────────────────────────────────────────────────

function startLocationTracking() {
    if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser.');
        return;
    }

    // Clear any existing watch
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }

    const geoOptions = {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0     // Always get fresh location
    };

    watchId = navigator.geolocation.watchPosition(
        onLocationSuccess,
        onLocationError,
        geoOptions
    );

    console.log('[Geo] Started watching position, watchId:', watchId);
}

function onLocationSuccess(position) {
    const { latitude, longitude, accuracy, heading, speed } = position.coords;
    const now = Date.now();

    myLocation = { latitude, longitude, accuracy, heading, speed };

    // Update our own marker
    if (myRole === 'driver') {
        updateDriverMarker(latitude, longitude, heading);
        // Draw accuracy circle
        updateAccuracyCircle(latitude, longitude, accuracy);
    } else if (myRole === 'customer') {
        updateCustomerMarker(latitude, longitude);
    }

    // Center map on first fix
    if (!mapCenteredOnce) {
        map.setView([latitude, longitude], 16);
        mapCenteredOnce = true;
    }

    // Throttle socket emissions
    if (now - lastEmitTime >= LOCATION_UPDATE_INTERVAL) {
        socket.emit('send-location', { latitude, longitude, accuracy, heading, speed });
        lastEmitTime = now;
    }

    // Update route if partner is known
    if (partnerLocation) {
        const driverPos = myRole === 'driver' ? myLocation : partnerLocation;
        const customerPos = myRole === 'customer' ? myLocation : partnerLocation;
        updateRouteAndDistance(driverPos, customerPos, speed);
    }

    console.log(`[Geo] Fix: ${latitude.toFixed(6)}, ${longitude.toFixed(6)} ±${accuracy?.toFixed(0)}m`);
}

function onLocationError(error) {
    console.error('[Geo] Error:', error.code, error.message);

    let msg = 'Location error';
    switch (error.code) {
        case 1: msg = 'Location permission denied. Please enable GPS.'; break;
        case 2: msg = 'Location unavailable. Check GPS signal.'; break;
        case 3: msg = 'Location request timed out. Retrying...'; break;
    }

    updatePartnerStatus(msg);

    // Retry on timeout or unavailable
    if (error.code === 3 || error.code === 2) {
        setTimeout(startLocationTracking, 3000);
    }
}

// ─── Marker Updates ───────────────────────────────────────────────────────────

function updateDriverMarker(lat, lng, heading) {
    if (driverMarker) {
        driverMarker.setLatLng([lat, lng]);
        driverMarker.setIcon(createDriverIcon(heading));
    } else {
        driverMarker = L.marker([lat, lng], {
            icon: createDriverIcon(heading),
            zIndexOffset: 1000
        }).addTo(map);
        driverMarker.bindPopup('<b>🏍️ Driver</b><br>Live location');
    }
}

function updateCustomerMarker(lat, lng) {
    if (customerMarker) {
        customerMarker.setLatLng([lat, lng]);
    } else {
        customerMarker = L.marker([lat, lng], {
            icon: createCustomerIcon(),
            zIndexOffset: 900
        }).addTo(map);
        customerMarker.bindPopup('<b>🏠 Your Location</b><br>Delivery destination');
    }
}

function updateAccuracyCircle(lat, lng, accuracy) {
    if (!accuracy) return;

    if (accuracyCircle) {
        accuracyCircle.setLatLng([lat, lng]);
        accuracyCircle.setRadius(accuracy);
    } else {
        accuracyCircle = L.circle([lat, lng], {
            radius: accuracy,
            className: 'accuracy-circle',
            fillColor: '#f8c200',
            fillOpacity: 0.12,
            color: '#f8c200',
            weight: 1.5,
            opacity: 0.5
        }).addTo(map);
    }
}

// ─── Routing & Distance ───────────────────────────────────────────────────────

function updateRouteAndDistance(driverPos, customerPos) {
    const distKm = haversineDistance(
        driverPos.latitude, driverPos.longitude,
        customerPos.latitude, customerPos.longitude
    );

    // Update info panel
    if (distKm < 1) {
        distanceValue.textContent = `${(distKm * 1000).toFixed(0)} m`;
    } else {
        distanceValue.textContent = `${distKm.toFixed(2)} km`;
    }

    // ETA based on speed or average
    const currentSpeedKmph = (driverPos.speed && driverPos.speed > 0.5)
        ? (driverPos.speed * 3.6)
        : AVG_SPEED_KMPH;

    const etaMinutesVal = (distKm / currentSpeedKmph) * 60;
    etaMinutes.textContent = etaMinutesVal < 1 ? '<1' : Math.round(etaMinutesVal).toString();

    // Update routing polyline (using Leaflet Routing Machine with OSRM)
    updateRoutingControl(driverPos, customerPos);
}

let lastRouteUpdateTime = 0;
const ROUTE_UPDATE_INTERVAL = 5000; // Update route every 5s max to avoid hammering OSRM

function updateRoutingControl(driverPos, customerPos) {
    const now = Date.now();
    if (now - lastRouteUpdateTime < ROUTE_UPDATE_INTERVAL) return;
    lastRouteUpdateTime = now;

    const from = L.latLng(driverPos.latitude, driverPos.longitude);
    const to = L.latLng(customerPos.latitude, customerPos.longitude);

    if (routingControl) {
        try {
            routingControl.setWaypoints([from, to]);
        } catch (e) {
            console.warn('[Route] setWaypoints error, recreating control:', e);
            removeRoutingControl();
            createRoutingControl(from, to);
        }
    } else {
        createRoutingControl(from, to);
    }
}

function createRoutingControl(from, to) {
    try {
        routingControl = L.Routing.control({
            waypoints: [from, to],
            routeWhileDragging: false,
            addWaypoints: false,
            draggableWaypoints: false,
            fitSelectedRoutes: false,
            show: false, // hide the directions panel
            collapsible: false,
            createMarker: function () { return null; }, // We handle markers ourselves
            lineOptions: {
                styles: [
                    {
                        color: '#1a1a2e',
                        weight: 5,
                        opacity: 0.15
                    },
                    {
                        color: '#f8c200',
                        weight: 4,
                        opacity: 1,
                        dashArray: '1, 8'
                    }
                ],
                extendToWaypoints: false,
                missingRouteTolerance: 0
            },
            router: L.Routing.osrmv1({
                serviceUrl: 'https://router.project-osrm.org/route/v1',
                profile: 'driving',
                useHints: false
            })
        }).addTo(map);

        // When route found, fit map to show both markers
        routingControl.on('routesfound', function (e) {
            const routes = e.routes;
            if (routes && routes.length > 0) {
                const summary = routes[0].summary;
                const totalDistKm = (summary.totalDistance / 1000).toFixed(2);
                const totalTimeMins = Math.round(summary.totalTime / 60);

                // Update with routing-calculated values (more accurate than Haversine)
                if (summary.totalDistance < 1000) {
                    distanceValue.textContent = `${summary.totalDistance.toFixed(0)} m`;
                } else {
                    distanceValue.textContent = `${totalDistKm} km`;
                }

                etaMinutes.textContent = totalTimeMins < 1 ? '<1' : totalTimeMins.toString();
                console.log(`[Route] Distance: ${totalDistKm} km, ETA: ${totalTimeMins} min`);
            }
        });

        routingControl.on('routingerror', function (e) {
            console.warn('[Route] Routing error:', e.error && e.error.message);
        });

    } catch (e) {
        console.error('[Route] Failed to create routing control:', e);
    }
}

function removeRoutingControl() {
    if (routingControl) {
        try {
            map.removeControl(routingControl);
        } catch (e) {
            console.warn('[Route] Error removing routing control:', e);
        }
        routingControl = null;
    }
}

// ─── Haversine Distance (fallback) ───────────────────────────────────────────

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRad(deg) {
    return deg * (Math.PI / 180);
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (socket.connected) {
            socket.emit('heartbeat');
        }
    }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setConnectionStatus(state, text) {
    connectionDot.className = state;
    connectionText.textContent = text;
}

function showDisconnectOverlay(msg) {
    disconnectMsg.textContent = msg || 'Waiting for partner to reconnect...';
    disconnectOverlay.classList.remove('hidden');
}

function hideDisconnectOverlay() {
    disconnectOverlay.classList.add('hidden');
}

function updatePartnerStatus(msg) {
    partnerStatusText.textContent = msg;
}

function resetInfoPanel() {
    etaMinutes.textContent = '--';
    distanceValue.textContent = '-- km';
    speedValue.textContent = '-- km/h';
}

// ─── Center Map Button ────────────────────────────────────────────────────────

centerBtn.addEventListener('click', () => {
    if (myLocation && partnerLocation) {
        // Fit both markers
        const bounds = L.latLngBounds(
            [myLocation.latitude, myLocation.longitude],
            [partnerLocation.latitude, partnerLocation.longitude]
        );
        map.fitBounds(bounds, { padding: [60, 60] });
    } else if (myLocation) {
        map.setView([myLocation.latitude, myLocation.longitude], 16);
    }
});

// ─── Page Visibility API — resume tracking when tab becomes visible ───────────

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && myRole) {
        console.log('[App] Page visible, ensuring location tracking is active...');
        startLocationTracking();
        if (socket.disconnected) {
            socket.connect();
        }
    }
});

// ─── Online/Offline Detection ─────────────────────────────────────────────────

window.addEventListener('online', () => {
    console.log('[Net] Back online');
    if (socket.disconnected) socket.connect();
});

window.addEventListener('offline', () => {
    console.log('[Net] Offline');
    setConnectionStatus('disconnected', 'No Internet');
});

// ─── Cleanup on unload ────────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
    }
    stopHeartbeat();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

initRole();
