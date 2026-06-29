const routesEl = document.querySelector("#routes");
const alertsEl = document.querySelector("#alerts");
const clockEl = document.querySelector("#clock");
const voiceToggle = document.querySelector("#voice-toggle");
const voiceTest = document.querySelector("#voice-test");
const systemVoiceTest = document.querySelector("#system-voice-test");
const voiceNameEl = document.querySelector("#voice-name");
const loginEl = document.querySelector("#login");
const loginForm = document.querySelector("#login-form");
const tokenInput = document.querySelector("#token-input");

let voiceEnabled = false;
let systemVoiceEnabled = false;
let preferredVoice = null;
const spoken = new Set();
const spokenSystem = new Set();
let accessToken = new URLSearchParams(window.location.search).get("token") || localStorage.getItem("busAlertToken") || "";

if (accessToken) {
  localStorage.setItem("busAlertToken", accessToken);
}

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  accessToken = tokenInput.value.trim();
  if (accessToken) {
    localStorage.setItem("busAlertToken", accessToken);
    loginEl.hidden = true;
    loadStatus();
  }
});

voiceToggle.addEventListener("click", () => {
  voiceEnabled = !voiceEnabled;
  if (voiceEnabled) {
    primeVoices();
    playChime();
    speak("Voice alerts are enabled. Please get your bag, key and wear your shoes.");
    voiceToggle.textContent = "Disable voice";
    return;
  }

  stopVoice();
  voiceToggle.textContent = "Enable voice";
  setVoiceStatus("Voice alerts are disabled.");
});

voiceTest.addEventListener("click", () => {
  voiceEnabled = true;
  primeVoices();
  playChime();
  speak("Test voice. You need to go right now. Hurry.");
});

systemVoiceTest.addEventListener("click", async () => {
  systemVoiceEnabled = true;
  playChime();
  systemVoiceTest.textContent = "Laptop voice enabled";
  systemVoiceTest.disabled = true;
  setVoiceStatus("Trying laptop system voice...");
  try {
    const response = await fetch("/api/say?message=test", { cache: "no-store" });
    const result = await response.json();
    setVoiceStatus(result.ok ? `System voice: ${result.voice}` : `System voice error: ${result.error}`);
  } catch (error) {
    setVoiceStatus(`System voice error: ${error.message}`);
  }
});

if ("speechSynthesis" in window) {
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    preferredVoice = pickPreferredVoice();
    updateVoiceName();
  });
  preferredVoice = pickPreferredVoice();
  updateVoiceName();
}

setInterval(updateClock, 1000);
setInterval(loadStatus, 10000);
updateClock();
loadStatus();

async function loadStatus() {
  try {
    const sample = new URLSearchParams(window.location.search).get("sample") === "1";
    const all = new URLSearchParams(window.location.search).get("all") === "1";
    const params = new URLSearchParams();
    if (sample) params.set("sample", "1");
    if (all) params.set("all", "1");
    const response = await fetch(`/api/status${params.toString() ? `?${params}` : ""}`, {
      cache: "no-store",
      headers: authHeaders()
    });
    if (response.status === 401) {
      showLogin();
      return;
    }
    const status = await response.json();
    render(status);
  } catch (error) {
    routesEl.innerHTML = `<div class="empty">Cannot load bus status. ${escapeHtml(error.message)}</div>`;
  }
}

function render(status) {
  if (!status.hasLtaKey) {
    routesEl.innerHTML = `<div class="empty">Missing LTA API key. Add LTA_ACCOUNT_KEY to .env and restart.</div>`;
    return;
  }

  renderAlerts(status.routes.flatMap((route) => route.alerts || []));

  if (status.demo) {
    alertsEl.insertAdjacentHTML("afterbegin", `<div class="alert">Demo mode is running. These bus times are sample data.</div>`);
  }

  routesEl.innerHTML = renderCommuteGroups(status);
}

function renderCommuteGroups(status) {
  const groups = status.commuteGroups?.length
    ? status.commuteGroups
    : [
        { id: "to-school", label: "Going to school", emptyMessage: "No active school trip right now." },
        { id: "from-school", label: "Coming back from school", emptyMessage: "No active trip home right now." }
      ];

  return groups.map((group) => {
    const routes = status.routes.filter((route) => (route.group || "to-school") === group.id);
    const body = routes.length
      ? routes.map(renderRoute).join("")
      : `<div class="empty">${escapeHtml(group.emptyMessage || "No active commute window right now.")}</div>`;

    return `
      <section class="commute-group">
        <div class="group-head">
          <h2>${escapeHtml(group.label)}</h2>
        </div>
        <div class="group-routes">${body}</div>
      </section>
    `;
  }).join("");
}

function renderRoute(route) {
  const errors = route.errors?.length ? renderRouteErrors(route.errors) : "";
  const buses = route.nextBuses.length
    ? route.nextBuses.map(renderBus).join("")
    : `<div class="empty">No live LTA bus arrivals right now for this route.</div>`;

  const safeBoardBy = route.checkMode === "live-only"
    ? `Live buses from ${route.originStopCode} to ${route.destinationStopCode}`
    : route.safeBoardBy
      ? `Safe board by ${route.safeBoardBy}`
      : "Travel time needs calibration";
  const scheduleWindow = route.scheduleWindow
    ? `<div class="schedule-window">Watch buses from ${escapeHtml(route.scheduleWindow.from)} to ${escapeHtml(route.scheduleWindow.until)} only</div>`
    : "";

  return `
    <article class="route">
      <div class="route-head">
        <div>
          <h2 class="route-title">${escapeHtml(routeTitle(route))}</h2>
          <div class="meta">${escapeHtml(routeIntent(route))} by ${escapeHtml(route.deadline)} · ${escapeHtml(route.destinationLabel)}</div>
          ${scheduleWindow}
        </div>
        <div class="meta">${escapeHtml(safeBoardBy)} · reach stop by ${escapeHtml(route.destinationArrivalTarget)}</div>
      </div>
      ${errors}
      <div class="bus-list">${buses}</div>
    </article>
  `;
}

function renderRouteErrors(errors) {
  return `
    <div class="route-errors">
      ${errors.map((error) => `
        <div class="route-error">Live LTA error for bus ${escapeHtml(error.serviceNo)}: ${escapeHtml(error.message)}</div>
      `).join("")}
    </div>
  `;
}

function renderBus(bus) {
  const originTime = new Date(bus.originArrivalTime);
  const arrival = formatTime(originTime);
  const minutesUntilOrigin = Number.isFinite(bus.minutesUntilOrigin)
    ? bus.minutesUntilOrigin
    : rawMinutesUntil(originTime);
  const liveLabel = liveArrivalLabel(minutesUntilOrigin);
  const destination = bus.conservativeDestinationArrival
    ? `Destination est. ${formatTime(new Date(bus.conservativeDestinationArrival))}`
    : "Destination estimate pending";

  return `
    <div class="bus ${escapeHtml(bus.status)}">
      <div class="bus-service">Bus ${escapeHtml(bus.serviceNo)}</div>
      <div class="bus-caption">Live LTA arrival</div>
      <div class="bus-time">${escapeHtml(liveLabel)}</div>
      <div class="meta">Arrives at your stop ${arrival}</div>
      <div class="meta">${escapeHtml(destination)}</div>
      <div class="bus-status">${escapeHtml(checkLabel(bus))}: ${escapeHtml(statusLabel(bus.status))}</div>
    </div>
  `;
}

function renderAlerts(alerts) {
  alertsEl.innerHTML = alerts
    .filter((alert) => !alert.alreadySent)
    .map((alert) => `<div class="alert">Bus ${escapeHtml(alert.serviceNo)} is coming in ${alert.minutesBefore} minutes. ${escapeHtml(alert.message)}</div>`)
    .join("");

  for (const alert of alerts) {
    const key = `${alert.routeId}:${alert.serviceNo}:${alert.originArrivalTime}:${alert.minutesBefore}`;
    if (!spoken.has(key) && voiceEnabled) {
      spoken.add(key);
      speak(alert.message);
    }
    if (!spokenSystem.has(key) && systemVoiceEnabled) {
      spokenSystem.add(key);
      systemSay(alert.minutesBefore === 8 ? "leave" : "prepare");
    }
  }
}

function speak(message) {
  if (!("speechSynthesis" in window)) {
    setVoiceStatus("Voice is not supported in this browser.");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  preferredVoice = pickPreferredVoice() || preferredVoice;
  if (preferredVoice) {
    utterance.voice = preferredVoice;
    utterance.lang = preferredVoice.lang;
  } else {
    utterance.lang = "en-GB";
  }
  utterance.rate = 0.82;
  utterance.pitch = 1.12;
  utterance.volume = 1;
  utterance.onstart = () => setVoiceStatus(`Speaking with ${preferredVoice ? preferredVoice.name : "default voice"}`);
  utterance.onend = () => updateVoiceName();
  utterance.onerror = (event) => setVoiceStatus(`Voice error: ${event.error || "unknown"}`);
  window.speechSynthesis.speak(utterance);

  setTimeout(() => {
    if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
      setVoiceStatus("No sound started. Check tablet volume and Android text-to-speech settings.");
    }
  }, 1200);
}

function stopVoice() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

function playChime() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    setVoiceStatus("Audio test is not supported in this browser.");
    return;
  }

  const audio = new AudioContext();
  const now = audio.currentTime;
  const notes = [660, 880, 990];

  notes.forEach((frequency, index) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    gain.connect(audio.destination);
    const start = now + index * 0.12;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.28, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
    oscillator.start(start);
    oscillator.stop(start + 0.18);
  });

  setTimeout(() => audio.close(), 800);
}

async function systemSay(messageKey) {
  setVoiceStatus("Laptop voice is speaking...");
  try {
    const response = await fetch(`/api/say?message=${encodeURIComponent(messageKey)}`, {
      cache: "no-store",
      headers: authHeaders()
    });
    const result = await response.json();
    setVoiceStatus(result.ok ? `Laptop voice: ${result.voice}` : `Laptop voice error: ${result.error}`);
  } catch (error) {
    setVoiceStatus(`Laptop voice error: ${error.message}`);
  }
}

function authHeaders() {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

function showLogin() {
  loginEl.hidden = false;
  routesEl.innerHTML = "";
  alertsEl.innerHTML = "";
  tokenInput.focus();
}

function pickPreferredVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const scored = voices.map((voice) => {
    const name = voice.name.toLowerCase();
    const lang = voice.lang.toLowerCase();
    let score = 0;

    if (lang === "en-gb") score += 100;
    if (lang.startsWith("en-gb")) score += 80;
    if (lang.startsWith("en-")) score += 20;
    if (name.includes("female")) score += 25;
    if (name.includes("woman")) score += 25;
    if (name.includes("samantha")) score += 20;
    if (name.includes("serena")) score += 20;
    if (name.includes("kate")) score += 20;
    if (name.includes("susan")) score += 15;
    if (name.includes("google uk english female")) score += 50;
    if (name.includes("male")) score -= 20;

    return { voice, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.voice || null;
}

function updateVoiceName() {
  if (!voiceNameEl) return;
  if (!("speechSynthesis" in window)) {
    voiceNameEl.textContent = "Voice is not supported in this browser.";
    return;
  }
  const voice = preferredVoice || pickPreferredVoice();
  voiceNameEl.textContent = voice
    ? `Voice: ${voice.name} (${voice.lang})`
    : "Voice: waiting for Android voices";
}

function primeVoices() {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.getVoices();
  preferredVoice = pickPreferredVoice();
  updateVoiceName();
}

function setVoiceStatus(message) {
  if (voiceNameEl) voiceNameEl.textContent = message;
}

function updateClock() {
  clockEl.textContent = new Intl.DateTimeFormat("en-SG", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
}

function formatTime(date) {
  return new Intl.DateTimeFormat("en-SG", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function minutesUntil(date) {
  return Math.max(0, Math.round((date - new Date()) / 60000));
}

function rawMinutesUntil(date) {
  return Math.round((date - new Date()) / 60000);
}

function liveArrivalLabel(minutes) {
  if (minutes < 0) return "Gone";
  if (minutes <= 1) return "At stop now";
  return `${minutes} min`;
}

function statusLabel(status) {
  return {
    safe: "Good choice",
    risky: "Maybe tight",
    late: "Too late",
    live: "Live arrival",
    "needs-travel-estimate": "Learning route"
  }[status] || status;
}

function routeTitle(route) {
  if (route.id === "weekday-school-61") return "School bus";
  if (route.id === "weekday-home-61") return "Home bus";
  if (route.id === "saturday-morning-97") return "Saturday morning bus";
  if (route.id === "saturday-afternoon-heng-mui-keng") return "Saturday afternoon bus";
  return route.label;
}

function routeIntent(route) {
  return (route.group || "to-school") === "from-school" ? "Get home" : "Get there";
}

function checkLabel(bus) {
  return bus.destinationStopCode === "14139" ? "Home check" : "School check";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
