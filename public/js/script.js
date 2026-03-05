const AVG_SPEED_KMPH = 30;
const LOCATION_UPDATE_INTERVAL = 2000;
const HEARTBEAT_INTERVAL = 15000;

const PATH_COLOR = '#1a73e8';

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

const etaMinutes = document.getElementById('eta-minutes');
const disconnectOverlay = document.getElementById('disconnect-overlay');
const disconnectMsg = document.getElementById('disconnect-msg');
const roleOverlay = document.getElementById('role-overlay');
const centerBtn = document.getElementById('center-btn');

const map = L.map('map', {
    zoomControl: false,
    attributionControl: false
}).setView([0, 0], 16);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; CartoDB'
}).addTo(map);

setTimeout(() => { map.invalidateSize(); }, 500);
setTimeout(() => { map.invalidateSize(); }, 2000);

function createDriverIcon() {
    return L.divIcon({
        className: 'driver-marker-wrap',
        html: `<div class="minimal-marker driver-dot"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
    });
}

function createCustomerIcon() {
    return L.divIcon({
        className: 'customer-marker-wrap',
        html: `<div class="minimal-marker customer-dot"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
    });
}

const socket = io();

socket.on('connect', () => {
    console.log('[Socket] Connected:', socket.id);
    if (myRole) {
        socket.emit('register-role', { role: myRole });
    }
    startHeartbeat();
});

socket.on('partner-connected', (data) => {
    console.log('[Socket] Partner connected:', data.role);
    isPartnerConnected = true;
    if (disconnectOverlay) disconnectOverlay.classList.add('hidden');
});

socket.on('partner-disconnected', (data) => {
    console.log('[Socket] Partner disconnected:', data.role);
    isPartnerConnected = false;

    if (disconnectOverlay) {
        disconnectMsg.textContent = `${data.role === 'driver' ? 'Driver' : 'Customer'} disconnected. Waiting...`;
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

function selectRole(role) {
    myRole = role;
    roleOverlay.classList.add('hidden');

    socket.emit('register-role', { role: role });
    startLocationTracking();
    console.log('[App] Role selected:', role);
}

function startLocationTracking() {
    if (!navigator.geolocation) return;

    if (watchId) navigator.geolocation.clearWatch(watchId);

    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const { latitude, longitude, accuracy, heading, speed } = pos.coords;
            const now = Date.now();
            myLocation = { latitude, longitude, accuracy, heading, speed };

            if (myRole === 'driver') updateDriverMarker(latitude, longitude);
            else if (myRole === 'customer') updateCustomerMarker(latitude, longitude);

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

function updateDriverMarker(lat, lng) {
    if (driverMarker) {
        driverMarker.setLatLng([lat, lng]);
    } else {
        driverMarker = L.marker([lat, lng], {
            icon: createDriverIcon(),
            zIndexOffset: 1000
        }).addTo(map);
        driverMarker.bindPopup("Driver Location").openPopup();
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
        customerMarker.bindPopup("Destination").openPopup();
    }
}

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
                styles: [{ color: '#1a73e8', weight: 6, opacity: 0.8, className: 'route-line-animated' }]
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

function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
        if (socket.connected) socket.emit('heartbeat');
    }, HEARTBEAT_INTERVAL);
}

centerBtn.addEventListener('click', () => {
    if (myLocation && partnerLocation) {
        const bounds = L.latLngBounds([myLocation.latitude, myLocation.longitude], [partnerLocation.latitude, partnerLocation.longitude]);
        map.fitBounds(bounds, { padding: [100, 100] });
    } else if (myLocation) {
        map.setView([myLocation.latitude, myLocation.longitude], 16);
    }
});

window.onload = () => {
    map.invalidateSize();

    const params = new URLSearchParams(window.location.search);
    const role = params.get('role');
    if (role === 'driver' || role === 'customer') {
        selectRole(role);
    } else {
        roleOverlay.classList.remove('hidden');
    }
};
