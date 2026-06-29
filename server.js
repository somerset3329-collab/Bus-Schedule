import { createServer } from "node:http";
import { readFile, appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(__dirname, "config", "commutes.json");
const LOG_PATH = path.join(__dirname, "data", "alert-events.jsonl");

loadEnv(path.join(__dirname, ".env"));

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || "127.0.0.1";
const ltaAccountKey = process.env.LTA_ACCOUNT_KEY;
const dashboardToken = process.env.DASHBOARD_TOKEN || "";
const allowSystemVoice = process.env.ALLOW_SYSTEM_VOICE === "true";
const homeSmsEnabled = process.env.ENABLE_HOME_SMS === "true";
const smsDelivery = process.env.SMS_DELIVERY || "phone";
const xiaomiMessageEnabled = process.env.ENABLE_XIAOMI_MESSAGE === "true";
const smsPollIntervalMs = Number(process.env.SMS_POLL_INTERVAL_SECONDS || 60) * 1000;
const twilio = {
  accountSid: process.env.TWILIO_ACCOUNT_SID || "",
  authToken: process.env.TWILIO_AUTH_TOKEN || "",
  from: process.env.TWILIO_FROM_NUMBER || "",
  to: process.env.SMS_TO_NUMBER || ""
};

const sentAlerts = new Set();
const phoneSmsQueue = [];
const xiaomiMessageQueue = [];
let systemVoiceQueue = Promise.resolve();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/status") {
      if (!isAuthorized(req, url)) return unauthorized(res);
      await sendJson(res, url.searchParams.get("sample") === "1" ? demoStatus() : await getStatus({
        includeAllRoutes: url.searchParams.get("all") === "1"
      }));
      return;
    }

    if (url.pathname === "/api/config") {
      if (!isAuthorized(req, url)) return unauthorized(res);
      await sendJson(res, publicConfig());
      return;
    }

    if (url.pathname === "/api/say") {
      if (!isLocalRequest(req) || !allowSystemVoice) {
        await sendJson(res, { ok: false, error: "System voice is disabled or not local." }, 403);
        return;
      }
      if (!isAuthorized(req, url)) return unauthorized(res);
      await handleSystemVoice(url, res);
      return;
    }

    if (url.pathname === "/api/test-sms") {
      if (!isLocalRequest(req)) {
        await sendJson(res, { ok: false, error: "SMS test is local-only." }, 403);
        return;
      }
      if (!isAuthorized(req, url)) return unauthorized(res);
      const result = await sendTwilioSms({
        message: "Bus Alert test SMS. Twilio is connected."
      });
      await sendJson(res, result, result.ok ? 200 : 500);
      return;
    }

    if (url.pathname === "/api/phone-sms") {
      if (!isAuthorized(req, url)) return unauthorized(res);
      await getStatus();
      const next = phoneSmsQueue.shift();
      await sendJson(res, next || { ok: true, pending: false, message: "NO_MESSAGE" });
      return;
    }

    if (url.pathname === "/api/xiaomi-message" || url.pathname === "/api/macrodroid-message") {
      if (!isAuthorized(req, url)) return unauthorized(res);
      await getStatus();
      const next = xiaomiMessageQueue.shift();
      await sendJson(res, next || { ok: true, pending: false, message: "NO_MESSAGE" });
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    await sendJson(res, { error: error.message || "Internal server error" }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`Bus alert dashboard: http://${host}:${port}`);
  if (homeSmsEnabled) {
    console.log(`Home reminder scheduler enabled with ${smsDelivery} delivery, polling every ${smsPollIntervalMs / 1000}s`);
  }
});

if (homeSmsEnabled) {
  setInterval(() => {
    getStatus().catch((error) => {
      console.error("Home SMS scheduler failed:", error);
    });
  }, smsPollIntervalMs);
}

async function getStatus(options = {}) {
  const now = new Date();
  const day = weekday(now);
  const currentMinutes = minutesSinceMidnight(now);
  const activeRoutes = config.routes.filter((route) => {
    if (!route.days.includes(day)) return false;
    if (options.includeAllRoutes) return true;
    const activeFrom = parseClock(route.activeFrom);
    const deadline = parseClock(route.deadline);
    return currentMinutes >= activeFrom - 30 && currentMinutes <= deadline;
  });

  const routes = [];
  for (const route of activeRoutes) {
    routes.push(await buildRouteStatus(route, now, options));
  }

  return {
    now: now.toISOString(),
    timezone: config.timezone,
    commuteGroups: config.commuteGroups || defaultCommuteGroups(),
    hasLtaKey: Boolean(ltaAccountKey),
    routes
  };
}

function isAuthorized(req, url) {
  if (!dashboardToken) return isLocalRequest(req);
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const token = bearer || url.searchParams.get("token") || "";
  return safeEqual(token, dashboardToken);
}

function isLocalRequest(req) {
  const remote = req.socket.remoteAddress || "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
}

async function unauthorized(res) {
  await sendJson(res, { error: "Unauthorized" }, 401);
}

async function handleSystemVoice(url, res) {
  const messageKey = url.searchParams.get("message") || "test";
  const messages = {
    prepare: config.messages.prepare,
    leave: config.messages.leaveNow,
    test: "Test voice. You need to go right now. Hurry."
  };
  const message = messages[messageKey];

  if (!message) {
    await sendJson(res, { ok: false, error: "Unknown message" }, 400);
    return;
  }

  if (process.platform !== "darwin") {
    await sendJson(res, { ok: false, error: "System voice test is only available on macOS." }, 400);
    return;
  }

  const voice = systemVoiceName();
  const args = voice ? ["-v", voice, "-r", "165", message] : ["-r", "165", message];
  try {
    systemVoiceQueue = systemVoiceQueue.then(() => speakWithSystemVoice(args));
    await systemVoiceQueue;
    await sendJson(res, { ok: true, voice: voice || "default", messageKey });
  } catch (error) {
    await sendJson(res, { ok: false, error: error.message }, 500);
  }
}

function speakWithSystemVoice(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("say", args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`say exited with code ${code}`));
    });
  });
}

function systemVoiceName() {
  if (process.platform !== "darwin") return null;
  const voices = readSystemVoices();
  const preferred = ["Serena", "Kate", "Samantha", "Susan", "Moira", "Tessa"];
  return preferred.find((name) => voices.includes(name)) || null;
}

function readSystemVoices() {
  try {
    const result = spawnSync("say", ["-v", "?"], { encoding: "utf8" });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

function demoStatus() {
  const now = new Date();
  const demoRoutes = config.routes
    .filter((route) => ["weekday-school-61", "weekday-home-61"].includes(route.id))
    .map((route) => buildDemoRoute(route, now));

  return {
    now: now.toISOString(),
    timezone: config.timezone,
    commuteGroups: config.commuteGroups || defaultCommuteGroups(),
    hasLtaKey: Boolean(ltaAccountKey),
    demo: true,
    routes: demoRoutes
  };
}

function buildDemoRoute(route, now) {
  const demoMinutes = route.group === "from-school" ? [12, 20, 31] : [8, 18, 27];
  const arrivals = demoMinutes.map((minutes, index) => {
    const originArrival = addMinutes(now, minutes);
    const bus = {
      slot: index + 1,
      serviceNo: route.services[0],
      originStopCode: route.originStopCode,
      destinationStopCode: route.destinationStopCode,
      originArrivalTime: originArrival.toISOString(),
      minutesUntilOrigin: minutes,
      load: index === 0 ? "SEA" : "SDA",
      type: "SD",
      feature: "WAB"
    };
    return classifyBus(route, bus);
  });

  return {
    ...route,
    destinationArrivalTarget: targetArrivalClock(route),
    safeBoardBy: safeBoardByClock(route),
    nextBuses: arrivals,
    alerts: [
      {
        routeId: route.id,
        routeLabel: route.label,
        serviceNo: route.services[0],
        minutesBefore: 15,
        originArrivalTime: arrivals[0].originArrivalTime,
        message: config.messages.prepare,
        channels: ["tablet-screen", "tablet-voice", "google-home", "sms", "xiaomi-kids"]
      },
      {
        routeId: route.id,
        routeLabel: route.label,
        serviceNo: route.services[0],
        minutesBefore: 8,
        originArrivalTime: arrivals[0].originArrivalTime,
        message: config.messages.leaveNow,
        channels: ["tablet-screen", "tablet-voice", "google-home", "sms", "xiaomi-kids"]
      }
    ],
    errors: []
  };
}

async function buildRouteStatus(route, now, options = {}) {
  const arrivals = [];
  const errors = [];

  for (const serviceNo of route.services) {
    try {
      const result = await fetchBusArrival(route.originStopCode, serviceNo);
      arrivals.push(...normalizeArrivals(route, serviceNo, result, now));
    } catch (error) {
      errors.push({ serviceNo, message: error.message });
    }
  }

  const visibleArrivals = options.includeAllRoutes
    ? arrivals
    : arrivals.filter((bus) => isInScheduleWindow(route, new Date(bus.originArrivalTime)));
  visibleArrivals.sort((a, b) => a.originArrivalTime.localeCompare(b.originArrivalTime));
  const nextBuses = visibleArrivals.slice(0, 3).map((bus) => classifyBus(route, bus));
  const alerts = nextBuses.flatMap((bus) => dueAlerts(route, bus, now));

  for (const alert of alerts) {
    const key = `${todayKey(now)}:${route.id}:${alert.serviceNo}:${alert.originArrivalTime}:${alert.minutesBefore}`;
    if (sentAlerts.has(key)) {
      alert.alreadySent = true;
    } else {
      sentAlerts.add(key);
      if (alert.smsEnabled && homeSmsEnabled && ["phone", "macrodroid"].includes(smsDelivery)) {
        queuePhoneSms(alert);
      } else if (alert.smsEnabled && homeSmsEnabled && smsDelivery === "twilio") {
        alert.sms = await sendTwilioSms(alert);
      }
      if (alert.smsEnabled && xiaomiMessageEnabled) {
        queueXiaomiMessage(alert);
      }
      await appendLog({ ...alert, routeId: route.id, createdAt: now.toISOString() });
    }
  }

  return {
    ...route,
    destinationArrivalTarget: targetArrivalClock(route),
    safeBoardBy: safeBoardByClock(route),
    nextBuses,
    alerts,
    errors
  };
}

function queuePhoneSms(alert) {
  phoneSmsQueue.push({
    ok: true,
    pending: true,
    delivery: smsDelivery,
    to: twilio.to,
    message: alert.message,
    routeId: alert.routeId,
    serviceNo: alert.serviceNo,
    minutesBefore: alert.minutesBefore,
    originArrivalTime: alert.originArrivalTime
  });
}

function queueXiaomiMessage(alert) {
  xiaomiMessageQueue.push({
    ok: true,
    pending: true,
    delivery: "xiaomi",
    message: alert.message,
    routeId: alert.routeId,
    serviceNo: alert.serviceNo,
    minutesBefore: alert.minutesBefore,
    originArrivalTime: alert.originArrivalTime
  });
}

function isInScheduleWindow(route, date) {
  if (!route.scheduleWindow) return true;
  const from = parseClock(route.scheduleWindow.from);
  const until = parseClock(route.scheduleWindow.until);
  const minutes = minutesSinceMidnight(date);
  return minutes >= from && minutes <= until;
}

async function fetchBusArrival(busStopCode, serviceNo) {
  if (!ltaAccountKey) {
    throw new Error("Missing LTA_ACCOUNT_KEY in .env");
  }

  const url = new URL("https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival");
  url.searchParams.set("BusStopCode", busStopCode);
  url.searchParams.set("ServiceNo", serviceNo);

  const response = await fetch(url, {
    headers: {
      AccountKey: ltaAccountKey,
      accept: "application/json"
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("LTA API rejected the AccountKey. Check LTA_ACCOUNT_KEY in .env.");
    }
    throw new Error(`LTA API ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

function normalizeArrivals(route, serviceNo, payload, now) {
  const service = payload.Services?.find((item) => item.ServiceNo === serviceNo);
  if (!service) return [];

  return ["NextBus", "NextBus2", "NextBus3"]
    .map((slot) => service[slot])
    .filter((bus) => bus?.EstimatedArrival)
    .map((bus, index) => {
      const originArrival = new Date(bus.EstimatedArrival);
      return {
        slot: index + 1,
        serviceNo,
        originStopCode: route.originStopCode,
        destinationStopCode: route.destinationStopCode,
        originArrivalTime: originArrival.toISOString(),
        minutesUntilOrigin: Math.max(0, Math.round((originArrival - now) / 60000)),
        load: bus.Load || null,
        type: bus.Type || null,
        feature: bus.Feature || null,
        latitude: bus.Latitude || null,
        longitude: bus.Longitude || null
      };
    });
}

function classifyBus(route, bus) {
  const originArrival = new Date(bus.originArrivalTime);
  const targetDestination = targetArrivalDate(route, originArrival);

  if (route.travelMaxMinutes == null || route.checkMode === "live-only") {
    const conservativeDestination = route.travelMaxMinutes == null ? null : addMinutes(originArrival, route.travelMaxMinutes);
    const optimisticDestination = route.travelMinMinutes == null ? null : addMinutes(originArrival, route.travelMinMinutes);
    return {
      ...bus,
      conservativeDestinationArrival: conservativeDestination?.toISOString() || null,
      optimisticDestinationArrival: optimisticDestination?.toISOString() || null,
      status: route.checkMode === "live-only" ? "live" : "needs-travel-estimate"
    };
  }

  const conservativeDestination = addMinutes(originArrival, route.travelMaxMinutes);
  const optimisticDestination = addMinutes(originArrival, route.travelMinMinutes ?? route.travelMaxMinutes);
  const status = conservativeDestination <= targetDestination
    ? "safe"
    : optimisticDestination <= targetDestination
      ? "risky"
      : "late";

  return {
    ...bus,
    conservativeDestinationArrival: conservativeDestination.toISOString(),
    optimisticDestinationArrival: optimisticDestination.toISOString(),
    status
  };
}

function dueAlerts(route, bus, now) {
  if (route.reminderStart && minutesSinceMidnight(now) < parseClock(route.reminderStart)) {
    return [];
  }

  const alertMinutes = route.alertsBeforeMinutes || config.alertsBeforeMinutes;
  const leaveNowMinute = route.leaveNowMinute ?? 8;
  return alertMinutes
    .filter((minutesBefore) => bus.minutesUntilOrigin <= minutesBefore && bus.minutesUntilOrigin >= minutesBefore - 1)
    .map((minutesBefore) => ({
      routeId: route.id,
      routeLabel: route.label,
      serviceNo: bus.serviceNo,
      originStopCode: route.originStopCode,
      destinationStopCode: route.destinationStopCode,
      destinationLabel: route.destinationLabel,
      minutesBefore,
      originArrivalTime: bus.originArrivalTime,
      message: alertMessage(route, bus, minutesBefore, leaveNowMinute),
      smsEnabled: isReminderAutomationEnabled(route),
      channels: isReminderAutomationEnabled(route)
        ? ["macrodroid", "xiaomi-kids"]
        : ["tablet-screen", "tablet-voice", "google-home", "xiaomi-kids"]
    }));
}

function alertMessage(route, bus, minutesBefore, leaveNowMinute) {
  if (isReminderAutomationEnabled(route)) return smsMessage(route, bus, minutesBefore);
  if (route.id === "weekday-school-61" && minutesBefore <= 10) {
    return schoolCountdownMessage(minutesBefore);
  }
  return minutesBefore <= leaveNowMinute ? config.messages.leaveNow : config.messages.prepare;
}

function isReminderAutomationEnabled(route) {
  return Boolean(route.automation?.enabled || route.sms?.enabled);
}

function schoolCountdownMessage(minutesBefore) {
  const base = `Bus arriving in ${minutesBefore} minutes.`;
  if (minutesBefore <= 7) {
    return `${base} You need to go right now. Hurry.`;
  }
  return base;
}

function smsMessage(route, bus, minutesBefore) {
  const arrival = formatDateTime(new Date(bus.originArrivalTime));
  if (minutesBefore <= 1) {
    return `Bus ${bus.serviceNo} is arriving at ${route.originStopCode} now.`;
  }
  return `Bus ${bus.serviceNo} arrives at ${route.originStopCode} in ${minutesBefore} min. ETA ${arrival}.`;
}

async function sendTwilioSms(alert) {
  if (!twilio.accountSid || !twilio.authToken || !twilio.from || !twilio.to) {
    return { ok: false, skipped: true, error: "Twilio SMS is not configured." };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilio.accountSid)}/Messages.json`;
  const body = new URLSearchParams({
    From: twilio.from,
    To: twilio.to,
    Body: alert.message
  });
  const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: result.message || "Twilio SMS failed."
      };
    }

    return {
      ok: true,
      sid: result.sid,
      status: result.status
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function targetArrivalClock(route) {
  return formatClock(parseClock(route.deadline) - route.destinationWalkMinutes - route.bufferMinutes);
}

function safeBoardByClock(route) {
  if (route.travelMaxMinutes == null) return null;
  return formatClock(parseClock(route.deadline) - route.destinationWalkMinutes - route.bufferMinutes - route.travelMaxMinutes);
}

function targetArrivalDate(route, referenceDate) {
  const targetMinutes = parseClock(route.deadline) - route.destinationWalkMinutes - route.bufferMinutes;
  const target = new Date(referenceDate);
  target.setHours(Math.floor(targetMinutes / 60), targetMinutes % 60, 0, 0);
  return target;
}

function publicConfig() {
  return {
    timezone: config.timezone,
    originStopCode: config.originStopCode,
    homeWalkMinutes: config.homeWalkMinutes,
    alertsBeforeMinutes: config.alertsBeforeMinutes,
    messages: config.messages,
    commuteGroups: config.commuteGroups || defaultCommuteGroups(),
    routes: config.routes.map((route) => ({
      id: route.id,
      label: route.label,
      group: route.group || "to-school",
      days: route.days,
      deadline: route.deadline,
      originStopCode: route.originStopCode,
      destinationStopCode: route.destinationStopCode,
      destinationLabel: route.destinationLabel,
      services: route.services
    }))
  };
}

function defaultCommuteGroups() {
  return [
    { id: "to-school", label: "Going to school", emptyMessage: "No active school trip right now." },
    { id: "from-school", label: "Coming back from school", emptyMessage: "No active trip home right now." }
  ];
}

async function serveStatic(urlPath, res) {
  const safePath = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  }[ext] || "application/octet-stream";

  res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  res.end(await readFile(filePath));
}

async function sendJson(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data, null, 2));
}

async function appendLog(event) {
  await appendFile(LOG_PATH, `${JSON.stringify(event)}\n`, "utf8");
}

function loadEnv(envPath) {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function weekday(date) {
  return ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][date.getDay()];
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function parseClock(clock) {
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatClock(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("en-SG", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: config.timezone
  }).format(date);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function dateAtClock(referenceDate, clock) {
  const minutes = parseClock(clock);
  const date = new Date(referenceDate);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date;
}

function todayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
