/*
  Smart Emergency Traffic Management System
  Ambulance Driver Dashboard (Frontend-only Prototype)

  What is simulated here:
  - ML traffic prediction (rule-based output)
  - Route suggestions (3 predefined routes)
  - GPS movement of ambulance marker
  - Automatic traffic signal override (within 3 km detection + near-signal override)

  What is NOT included:
  - No backend, no APIs, no real database, no real ML model.
*/

// -----------------------------
// Helper: distance calculation
// -----------------------------
function toRad(deg) {
  return deg * Math.PI / 180;
}

// Haversine distance (km)
function distanceKm(a, b) {
  const R = 6371;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);

  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * (Math.sin(dLon / 2) ** 2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

function polylineDistanceKm(coords) {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    total += distanceKm(coords[i], coords[i + 1]);
  }
  return total;
}

function formatKm(km) {
  if (!isFinite(km)) return '—';
  return `${km.toFixed(2)} km`;
}

function formatMinutes(min) {
  if (!isFinite(min)) return '—';
  if (min < 1) return '< 1 min';
  return `${Math.round(min)} min`;
}

// -----------------------------
// 1) Map Setup (Leaflet + OSM)
// -----------------------------
const CITY_CENTER = [10.9601, 78.0766]; // Karur, Tamil Nadu

const map = L.map('map', { zoomControl: true }).setView(CITY_CENTER, 13.2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// -----------------------------
// 2) Traffic Signal Setup
// -----------------------------
// Multiple traffic signals (demo) around Karur.
// In a real system, these would be real junction/signal coordinates.
const SIGNAL_DEFS = [
  { id: 'S1', location: [10.9558, 78.0748] },
  { id: 'S2', location: [10.9639, 78.0795] },
  { id: 'S3', location: [10.9696, 78.0856] }
];

const SIGNAL_STATE = {
  NORMAL: 'Normal Traffic Mode',
  OVERRIDE: 'Green for Ambulance (Override)'
};

// Traffic signal marker as a small "real" traffic light icon (SVG).
// We keep it simple: normal mode shows red, override shows green.
function makeTrafficSignalIcon(mode) {
  const redOn = mode === SIGNAL_STATE.NORMAL;
  const greenOn = mode === SIGNAL_STATE.OVERRIDE;
  const red = redOn ? '#ef4444' : '#7f1d1d';
  const yellow = '#f59e0b';
  const green = greenOn ? '#22c55e' : '#14532d';

  return L.divIcon({
    className: '',
    iconSize: [26, 38],
    iconAnchor: [13, 38],
    html: `
      <div style="width:26px;height:38px;">
        <svg width="26" height="38" viewBox="0 0 26 38" xmlns="http://www.w3.org/2000/svg" aria-label="Traffic Signal">
          <rect x="6" y="1" width="14" height="26" rx="3" fill="#111" stroke="#2b2b2b" stroke-width="1" />
          <circle cx="13" cy="7" r="3.2" fill="${red}" />
          <circle cx="13" cy="14" r="3.2" fill="${yellow}" opacity="0.45" />
          <circle cx="13" cy="21" r="3.2" fill="${green}" />
          <rect x="11.6" y="27" width="2.8" height="7" fill="#444" />
          <rect x="9" y="34" width="8" height="3" rx="1" fill="#555" />
        </svg>
      </div>
    `
  });
}

// Create markers once
const signalMarkers = SIGNAL_DEFS.map((s) => {
  const m = L.marker(s.location, { icon: makeTrafficSignalIcon(SIGNAL_STATE.NORMAL) }).addTo(map);
  m.bindPopup(`Traffic Signal ${s.id}`);
  return m;
});

let currentSignalState = SIGNAL_STATE.NORMAL;

// Runtime state per signal for the current drive
let signalRuntime = SIGNAL_DEFS.map((s, idx) => ({
  id: s.id,
  location: s.location,
  marker: signalMarkers[idx],
  state: SIGNAL_STATE.NORMAL,
  nearestIndex: null,
  minDistance: Infinity,
  lastDistance: null,
  advanceTriggered: false,
  overrideActive: false,
  passed: false
}));

function renderSignalList(activeSignalId) {
  const host = document.getElementById('signalList');
  if (!host) return;
  if (!Array.isArray(signalRuntime)) {
    host.textContent = '';
    return;
  }

  const activeId = (activeSignalId ?? document.getElementById('signalId')?.textContent ?? '').trim();
  host.textContent = '';

  for (const s of signalRuntime) {
    const row = document.createElement('div');
    row.className = `signal-row${activeId && s.id === activeId ? ' signal-row--active' : ''}`;

    const left = document.createElement('div');
    left.className = 'signal-row__id';
    left.textContent = s.id;

    const right = document.createElement('div');
    right.className = 'signal-row__state';
    right.textContent = s.state;

    row.appendChild(left);
    row.appendChild(right);
    host.appendChild(row);
  }
}

function setSignalStateFor(signal, state) {
  signal.state = state;
  currentSignalState = state;
  const idEl = document.getElementById('signalId');
  if (idEl) idEl.textContent = signal.id;
  document.getElementById('signalMode').textContent = state;
  signal.marker.setIcon(makeTrafficSignalIcon(state));
  renderSignalList(signal.id);
}

function setAllSignalsNormal() {
  signalRuntime.forEach((s) => {
    s.state = SIGNAL_STATE.NORMAL;
    s.marker.setIcon(makeTrafficSignalIcon(SIGNAL_STATE.NORMAL));
    s.advanceTriggered = false;
    s.overrideActive = false;
    s.passed = false;
    s.minDistance = Infinity;
    s.lastDistance = null;
    s.nearestIndex = null;
  });
  const idEl = document.getElementById('signalId');
  if (idEl) idEl.textContent = '—';
  document.getElementById('signalMode').textContent = SIGNAL_STATE.NORMAL;
  renderSignalList();
}

// -----------------------------
// 3) Ambulance Marker + Icon
// -----------------------------
// Inline SVG icon so it looks like an ambulance.
const ambulanceIcon = L.divIcon({
  className: '',
  iconSize: [34, 22],
  iconAnchor: [17, 11],
  html: `
    <div style="width:34px;height:22px;">
      <svg width="34" height="22" viewBox="0 0 34 22" xmlns="http://www.w3.org/2000/svg" aria-label="Ambulance">
        <rect x="2" y="7" width="21" height="9" rx="2" fill="#ffffff" stroke="#b91c1c" stroke-width="2" />
        <rect x="21" y="9" width="10" height="7" rx="2" fill="#ffffff" stroke="#b91c1c" stroke-width="2" />
        <rect x="23" y="10" width="4" height="3" fill="#dbeafe" stroke="#93c5fd" stroke-width="1" />
        <circle cx="9" cy="18" r="3" fill="#111" />
        <circle cx="25" cy="18" r="3" fill="#111" />
        <rect x="10" y="10" width="6" height="3" fill="#b91c1c" />
        <rect x="12" y="8.5" width="2" height="6" fill="#b91c1c" />
        <rect x="4" y="5" width="6" height="2" rx="1" fill="#ef4444" />
      </svg>
    </div>
  `
});

// Marker position will be set after route selection.
let ambulanceMarker = L.marker(CITY_CENTER, { icon: ambulanceIcon }).addTo(map);
ambulanceMarker.bindPopup('Ambulance');

// -----------------------------
// 4) Route Options (3 predefined)
// -----------------------------
// These are demo routes inside Chennai area.
// In a real system, routes are computed using maps + traffic data.
const ROUTES = {
  fastest: {
    id: 'fastest',
    name: 'Fastest Route',
    tag: 'Recommended – Low Traffic',
    baseTraffic: 'Low',
    coords: [
      // Karur local demo route (points are approximate, for simulation only)
      [10.9488, 78.0690],
      [10.9526, 78.0718],
      [10.9562, 78.0742],
      [10.9591, 78.0762],
      [10.9622, 78.0783],
      [10.9652, 78.0810],
      [10.9680, 78.0840],
      [10.9712, 78.0873]
    ]
  },
  alternative: {
    id: 'alternative',
    name: 'Alternative Route',
    tag: 'Medium Traffic',
    baseTraffic: 'Medium',
    coords: [
      [10.9488, 78.0690],
      [10.9504, 78.0750],
      [10.9536, 78.0812],
      [10.9578, 78.0860],
      [10.9630, 78.0892],
      [10.9686, 78.0903],
      [10.9712, 78.0873]
    ]
  },
  shortest: {
    id: 'shortest',
    name: 'Shortest Distance Route',
    tag: 'High Traffic',
    baseTraffic: 'High',
    coords: [
      [10.9488, 78.0690],
      [10.9548, 78.0736],
      [10.9606, 78.0780],
      [10.9662, 78.0827],
      [10.9712, 78.0873]
    ]
  }
};

let selectedRouteId = null;
let selectedRouteLine = null;

function setRouteHighlight(on) {
  if (!selectedRouteLine) return;
  if (on) {
    selectedRouteLine.setStyle({ color: '#16a34a', weight: 5, opacity: 0.95 });
  } else {
    selectedRouteLine.setStyle({ color: '#1d4ed8', weight: 4, opacity: 0.85 });
  }
}

function setSelectedRoute(routeId) {
  selectedRouteId = routeId;
  const startBtn = document.getElementById('startDriveBtn');
  startBtn.disabled = !selectedRouteId;

  // Update UI selection styles
  document.querySelectorAll('.route').forEach((el) => {
    const isSel = el.getAttribute('data-route-id') === routeId;
    el.classList.toggle('route--selected', isSel);
  });

  // Draw selected route on map
  const route = ROUTES[routeId];
  if (!route) return;

  if (selectedRouteLine) {
    map.removeLayer(selectedRouteLine);
    selectedRouteLine = null;
  }

  selectedRouteLine = L.polyline(route.coords, {
    color: '#1d4ed8',
    weight: 4,
    opacity: 0.85
  }).addTo(map);

  map.fitBounds(selectedRouteLine.getBounds(), { padding: [30, 30] });

  // Reset ambulance to the start of selected route
  ambulanceMarker.setLatLng(route.coords[0]);

  // When a new route is selected, we reset visual state back to normal color.
  // It will turn green automatically when within 3 km of the signal.
  setRouteHighlight(false);
}

// -----------------------------
// Event log (timestamps)
// -----------------------------
function logEvent(message) {
  const el = document.getElementById('eventLog');
  if (!el) return;
  const t = new Date().toLocaleTimeString();
  const item = document.createElement('div');
  item.className = 'log__item';
  item.innerHTML = `<span class="log__time">[${t}]</span>${message}`;
  el.prepend(item);
}

function clearLog() {
  const el = document.getElementById('eventLog');
  if (el) el.innerHTML = '';
}

// -----------------------------
// 5) ML Traffic Prediction (Simulated)
// -----------------------------
// This function gives a traffic level based on time + selected accident location.
// In real system: ML model uses past traffic stored in DBMS.
function predictTrafficLevel(accidentKey) {
  const hour = new Date().getHours();
  const peak = (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19);

  // Small bias by location
  const bias = {
    guindy: 1,
    tnagar: 2,
    egmore: 2,
    central: 3
  }[accidentKey] ?? 1;

  const score = (peak ? 2 : 0) + bias;

  if (score >= 4) return 'High';
  if (score >= 3) return 'Medium';
  return 'Low';
}

function trafficBadgeClass(level) {
  if (level === 'Low') return 'badge badge--low';
  if (level === 'Medium') return 'badge badge--med';
  if (level === 'High') return 'badge badge--high';
  return 'badge badge--neutral';
}

function renderPrediction(level) {
  document.getElementById('predictedTraffic').textContent = level;
  const badge = document.getElementById('predictionBadge');
  badge.className = trafficBadgeClass(level);
  badge.textContent = `Prediction: ${level}`;
}

// -----------------------------
// 6) Route Suggestion Panel Rendering
// -----------------------------
function estimatedTimeMinutes(distance, trafficLevel) {
  // Base speed (km/h)
  const baseSpeed = 35;
  const baseMinutes = (distance / baseSpeed) * 60;

  // Traffic multiplier (simple)
  const mult = trafficLevel === 'Low' ? 1.0 : trafficLevel === 'Medium' ? 1.25 : 1.55;
  return baseMinutes * mult;
}

function buildRouteCards(predictedTraffic) {
  // We use baseTraffic and adjust slightly using predictedTraffic.
  // This is only to make the UI feel realistic.
  const adjust = (base) => {
    if (predictedTraffic === 'High' && base === 'Low') return 'Medium';
    if (predictedTraffic === 'High' && base === 'Medium') return 'High';
    if (predictedTraffic === 'Low' && base === 'High') return 'Medium';
    return base;
  };

  const container = document.getElementById('routes');
  container.innerHTML = '';

  const routeList = [ROUTES.fastest, ROUTES.alternative, ROUTES.shortest].map((r) => {
    const distance = polylineDistanceKm(r.coords);
    const traffic = adjust(r.baseTraffic);
    const timeMin = estimatedTimeMinutes(distance, traffic);
    return { ...r, distance, traffic, timeMin };
  });

  // Recommended route: lowest traffic, then lowest time
  routeList.sort((a, b) => {
    const tRank = (x) => x === 'Low' ? 1 : x === 'Medium' ? 2 : 3;
    const diff = tRank(a.traffic) - tRank(b.traffic);
    if (diff !== 0) return diff;
    return a.timeMin - b.timeMin;
  });
  const recommendedId = routeList[0].id;

  // Render in fixed order but mark recommendation on "Fastest Route" card label.
  const renderOrder = ['fastest', 'alternative', 'shortest'];
  renderOrder.forEach((id) => {
    const r = routeList.find(x => x.id === id);
    const tagText = (id === 'fastest') ? 'Recommended – Low Traffic' : r.tag;
    const trafficCls = trafficBadgeClass(r.traffic);

    const card = document.createElement('div');
    card.className = 'route';
    card.setAttribute('data-route-id', r.id);

    card.innerHTML = `
      <div class="route__top">
        <div>
          <div class="route__name">${r.name}</div>
          <div class="muted">${tagText}</div>
        </div>
        <div class="${trafficCls}">${r.traffic}</div>
      </div>
      <div class="route__meta">
        <div class="meta">
          <div class="meta__label">Distance</div>
          <div class="meta__value">${formatKm(r.distance)}</div>
        </div>
        <div class="meta">
          <div class="meta__label">Estimated Time</div>
          <div class="meta__value">${formatMinutes(r.timeMin)}</div>
        </div>
        <div class="meta">
          <div class="meta__label">Traffic</div>
          <div class="meta__value">${r.traffic}</div>
        </div>
      </div>
      <div class="route__actions">
        <button class="btn tiny-btn" type="button" data-pick-route="${r.id}">Select</button>
      </div>
    `;

    container.appendChild(card);
  });

  // Button actions (select route)
  container.querySelectorAll('[data-pick-route]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.getAttribute('data-pick-route');
      setSelectedRoute(id);
    });
  });

  // Auto-select recommended route
  setSelectedRoute(recommendedId);
}

// -----------------------------
// 7) Emergency Mode (UI)
// -----------------------------
let emergencyMode = false;

function setEmergencyMode(on) {
  emergencyMode = on;
  const pill = document.getElementById('emergencyPill');
  const btn = document.getElementById('toggleEmergencyBtn');

  if (on) {
    pill.textContent = 'ON';
    pill.className = 'pill pill--on';
    btn.textContent = 'Turn OFF';
  } else {
    pill.textContent = 'OFF';
    pill.className = 'pill pill--off';
    btn.textContent = 'Turn ON';
  }
}

document.getElementById('toggleEmergencyBtn').addEventListener('click', () => {
  setEmergencyMode(!emergencyMode);
});

// -----------------------------
// 8) Drive Simulation (GPS movement + signal control)
// -----------------------------

let isDriving = false;
let driveTimer = null;
let currentIndex = 0;
let segmentProgress = 0;

// Slow movement
const TICK_MS = 200;
const SEGMENT_TIME_MS = 4200;
const STEP = TICK_MS / SEGMENT_TIME_MS;

// Detection thresholds
const ADVANCE_DETECTION_KM = 3.0;
const OVERRIDE_START_KM = 0.40;
const OVERRIDE_END_KM = 0.15;

function setAdvanceDetection(active) {
  document.getElementById('advanceDetection').textContent = active ? 'Active' : 'Inactive';
}

function setDistanceUI(km) {
  document.getElementById('distanceToSignal').textContent = formatKm(km);
}

function setAutoControl(on) {
  document.getElementById('autoControl').textContent = on ? 'ON' : 'OFF';
}

function stopDriveTimer() {
  if (driveTimer) {
    clearInterval(driveTimer);
    driveTimer = null;
  }
}

function resetDriveState() {
  stopDriveTimer();
  isDriving = false;
  currentIndex = 0;
  segmentProgress = 0;

  setAllSignalsNormal();
  setAdvanceDetection(false);
  setDistanceUI(NaN);
  setAutoControl(false);

  // Clear "active" placeholders
  const idEl = document.getElementById('signalId');
  if (idEl) idEl.textContent = '—';
  document.getElementById('signalMode').textContent = SIGNAL_STATE.NORMAL;
  renderSignalList();
}

function interpolatePoint(a, b, t) {
  const lat = a[0] + (b[0] - a[0]) * t;
  const lng = a[1] + (b[1] - a[1]) * t;
  return [lat, lng];
}

function handleAdvanceDetectionFor(signal, distanceToSignalKm) {
  if (signal.advanceTriggered) return;
  if (distanceToSignalKm <= ADVANCE_DETECTION_KM) {
    signal.advanceTriggered = true;
    setAdvanceDetection(true);
    setAutoControl(true);
    setRouteHighlight(true);
    logEvent(`${signal.id}: 3 km detection triggered. Preparing signal override.`);
  }
}

function handleSignalOverrideFor(signal, distanceToSignalKm) {
  if (!signal.overrideActive && distanceToSignalKm <= OVERRIDE_START_KM) {
    signal.overrideActive = true;
    setSignalStateFor(signal, SIGNAL_STATE.OVERRIDE);
    logEvent(`${signal.id}: Signal override ON (Green for Ambulance).`);
  }
}

function handleAfterCrossingFor(signal, distanceToSignalKm) {
  if (signal.passed) return;
  if (signal.lastDistance === null) {
    signal.lastDistance = distanceToSignalKm;
    return;
  }

  // Immediate "passed signal" logic:
  // Once the ambulance comes very close to the signal and then starts moving away,
  // we consider it crossed and revert the signal back to normal (red).
  // This keeps the demo stable and easy to explain.
  const closeEnough = signal.minDistance <= OVERRIDE_START_KM;
  const movingAwayFromMin = distanceToSignalKm > (signal.minDistance + 0.03); // ~30 meters buffer
  const passedIndex = typeof signal.nearestIndex === 'number'
    ? (currentIndex > signal.nearestIndex || (currentIndex === signal.nearestIndex && segmentProgress >= 0.6))
    : false;

  if (signal.overrideActive && closeEnough && (movingAwayFromMin || passedIndex)) {
    signal.passed = true;
    signal.overrideActive = false;
    setSignalStateFor(signal, SIGNAL_STATE.NORMAL);
    setAutoControl(false);
    setAdvanceDetection(false);
    setRouteHighlight(false);
    logEvent(`${signal.id}: Ambulance crossed signal. Override OFF, normal resumed.`);

    signal.lastDistance = distanceToSignalKm;
    return;
  }

  // Fallback (older logic)
  const gotClose = signal.lastDistance <= OVERRIDE_START_KM;
  const movingAway = distanceToSignalKm > signal.lastDistance;
  if (signal.overrideActive && gotClose && movingAway && distanceToSignalKm >= OVERRIDE_END_KM) {
    signal.passed = true;
    signal.overrideActive = false;
    setSignalStateFor(signal, SIGNAL_STATE.NORMAL);
    setAutoControl(false);
    setAdvanceDetection(false);
    setRouteHighlight(false);
    logEvent(`${signal.id}: Ambulance crossed signal. Override OFF, normal resumed.`);
  }

  signal.lastDistance = distanceToSignalKm;
}

function getNextSignal() {
  // Next signal = first one not passed and (nearestIndex is ahead or current)
  const candidates = signalRuntime
    .filter(s => !s.passed && typeof s.nearestIndex === 'number')
    .sort((a, b) => a.nearestIndex - b.nearestIndex);

  for (const s of candidates) {
    if (currentIndex <= s.nearestIndex + 1) return s;
  }
  return candidates.length ? candidates[candidates.length - 1] : null;
}

function driveTick() {
  if (!isDriving || !selectedRouteId) return;

  const route = ROUTES[selectedRouteId];
  const coords = route.coords;

  if (currentIndex >= coords.length - 1) {
    stopDriveTimer();
    isDriving = false;
    return;
  }

  const a = coords[currentIndex];
  const b = coords[currentIndex + 1];

  segmentProgress += STEP;
  if (segmentProgress >= 1) {
    currentIndex++;
    segmentProgress = 0;
  }

  const pos = interpolatePoint(a, b, segmentProgress);
  ambulanceMarker.setLatLng(pos);

  // Keep the ambulance visible while driving.
  // Pan only if it goes near the edge.
  const safeBounds = map.getBounds().pad(-0.15);
  if (!safeBounds.contains(pos)) {
    map.panTo(pos, { animate: true, duration: 0.25 });
  }

  // Work with the next upcoming signal on the selected route
  const nextSignal = getNextSignal();

  if (!nextSignal) {
    setDistanceUI(NaN);
    const idEl = document.getElementById('signalId');
    if (idEl) idEl.textContent = '—';
    document.getElementById('signalMode').textContent = SIGNAL_STATE.NORMAL;
    renderSignalList();
    return;
  }

  const distKm = distanceKm(pos, nextSignal.location);
  if (distKm < nextSignal.minDistance) nextSignal.minDistance = distKm;
  setDistanceUI(distKm);

  // Keep status label consistent (two lines)
  {
    const idEl = document.getElementById('signalId');
    if (idEl) idEl.textContent = nextSignal.id;
    document.getElementById('signalMode').textContent = nextSignal.state;
  }

  renderSignalList(nextSignal.id);

  handleAdvanceDetectionFor(nextSignal, distKm);
  handleSignalOverrideFor(nextSignal, distKm);
  handleAfterCrossingFor(nextSignal, distKm);
}

function startEmergencyDrive() {
  // If routes are not generated/selected yet, guide the user.
  if (!selectedRouteId) {
    alert('First click "Suggest Low Traffic Route" and select a route.');
    return;
  }
  if (isDriving) return;

  // Turning on emergency mode makes sense for demo
  setEmergencyMode(true);

  resetDriveState();
  isDriving = true;

  // Start from route beginning
  const route = ROUTES[selectedRouteId];
  ambulanceMarker.setLatLng(route.coords[0]);

  // Pre-calculate nearest waypoint index for EACH signal.
  signalRuntime.forEach((s) => {
    let best = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < route.coords.length; i++) {
      const d = distanceKm(route.coords[i], s.location);
      if (d < best) {
        best = d;
        bestIdx = i;
      }
    }
    s.nearestIndex = bestIdx;
    s.minDistance = Infinity;
    s.lastDistance = null;
    s.advanceTriggered = false;
    s.overrideActive = false;
    s.passed = false;
    s.state = SIGNAL_STATE.NORMAL;
    s.marker.setIcon(makeTrafficSignalIcon(SIGNAL_STATE.NORMAL));
  });

  renderSignalList();

  clearLog();
  logEvent('Emergency drive started.');
  logEvent(`Selected route: ${route.name}`);

  // Focus map on the selected route (professional feel)
  if (selectedRouteLine) {
    map.fitBounds(selectedRouteLine.getBounds(), { padding: [30, 30] });
  } else {
    map.setView(route.coords[0], 13.2);
  }

  driveTimer = setInterval(driveTick, TICK_MS);
}

// -----------------------------
// 9) Buttons (Suggest + Start + Reset)
// -----------------------------

document.getElementById('suggestRouteBtn').addEventListener('click', () => {
  const accidentKey = document.getElementById('accidentSelect').value;
  const predicted = predictTrafficLevel(accidentKey);
  renderPrediction(predicted);
  buildRouteCards(predicted);
});

document.getElementById('startDriveBtn').addEventListener('click', startEmergencyDrive);

document.getElementById('resetBtn').addEventListener('click', () => {
  resetDriveState();
  setEmergencyMode(false);
  clearLog();
  logEvent('System reset. Ready.');

  document.getElementById('predictedTraffic').textContent = '—';
  const badge = document.getElementById('predictionBadge');
  badge.className = 'badge badge--neutral';
  badge.textContent = 'No prediction yet';

  document.getElementById('routes').innerHTML = '';
  selectedRouteId = null;
  document.getElementById('startDriveBtn').disabled = true;

  if (selectedRouteLine) {
    map.removeLayer(selectedRouteLine);
    selectedRouteLine = null;
  }

  ambulanceMarker.setLatLng(CITY_CENTER);
  map.setView(CITY_CENTER, 13.2);
});

// Initial UI values
setEmergencyMode(false);
resetDriveState();
renderSignalList();

// Auto-load a default suggestion so the dashboard is ready immediately.
// This avoids confusion where the Start button stays disabled.
(function initDefaultSuggestion() {
  const accidentKey = document.getElementById('accidentSelect').value;
  const predicted = predictTrafficLevel(accidentKey);
  renderPrediction(predicted);
  buildRouteCards(predicted);
})();
