# Bus Schedule Operation Manual

This manual explains how to run the bus alert app from another laptop or phone.

## 1. What This App Does

The app checks Singapore LTA bus arrival data and shows reminders for:

- Going to school: `14131 -> 11291`, bus `61`
- Coming back from school: `11299 -> 14139`, bus `61`

Going to school uses the dashboard and voice alerts.

Coming back from school starts reminders from `14:00` and can send regular SMS from your phone through MacroDroid.

## 2. Required Accounts And Apps

You need:

- LTA DataMall AccountKey
- GitHub account
- Render account
- A phone with a SIM card if you want regular SMS
- MacroDroid installed on the phone if you want automatic SMS

Optional:

- Galaxy Tab for dashboard and voice alerts
- Xiaomi Kids app automation later

## 3. Run On Another Laptop

Install Node.js first:

```text
https://nodejs.org
```

Clone the project:

```sh
git clone https://github.com/somerset3329-collab/Bus-Schedule.git
cd Bus-Schedule
```

Create `.env`:

```sh
cp .env.example .env
```

Edit `.env` and fill these values:

```env
LTA_ACCOUNT_KEY=your_lta_key
PORT=3100
HOST=127.0.0.1
SMS_TO_NUMBER=+65xxxxxxxx
DASHBOARD_TOKEN=your_dashboard_token
ALLOW_SYSTEM_VOICE=false
ENABLE_HOME_SMS=true
SMS_DELIVERY=phone
ENABLE_XIAOMI_MESSAGE=false
SMS_POLL_INTERVAL_SECONDS=60
```

Start the server:

```sh
npm start
```

Open in browser:

```text
http://127.0.0.1:3100?token=YOUR_DASHBOARD_TOKEN
```

Test all routes, ignoring active time windows:

```text
http://127.0.0.1:3100?all=1&token=YOUR_DASHBOARD_TOKEN
```

## 4. Run From A Phone On The Same Wi-Fi

On the laptop `.env`, set:

```env
HOST=0.0.0.0
```

Restart the server:

```sh
npm start
```

Find the laptop IP address.

On macOS:

```sh
ipconfig getifaddr en0
```

If the IP is `192.168.1.25`, open this on the phone:

```text
http://192.168.1.25:3100?token=YOUR_DASHBOARD_TOKEN
```

This only works when the phone and laptop are on the same Wi-Fi, and the laptop stays on.

## 5. Cloud Deployment With Render

Render is recommended for daily use because the server stays online.

Render setup:

```text
Render Dashboard
→ New
→ Web Service
→ Connect GitHub repository
→ somerset3329-collab/Bus-Schedule
```

Use:

```text
Build Command: npm install
Start Command: npm start
```

Set these environment variables in Render:

```env
HOST=0.0.0.0
ALLOW_SYSTEM_VOICE=false
ENABLE_HOME_SMS=true
SMS_DELIVERY=phone
ENABLE_XIAOMI_MESSAGE=false
SMS_POLL_INTERVAL_SECONDS=60
LTA_ACCOUNT_KEY=your_lta_key
DASHBOARD_TOKEN=your_dashboard_token
SMS_TO_NUMBER=+65xxxxxxxx
```

Do not upload `.env` to Render. Put values in Render Environment settings.

After deployment, open:

```text
https://YOUR_RENDER_URL?token=YOUR_DASHBOARD_TOKEN
```

Example:

```text
https://bus-schedule-4yss.onrender.com?token=YOUR_DASHBOARD_TOKEN
```

## 6. Phone MacroDroid Regular SMS

This sends normal SMS from your phone.

Install MacroDroid on your phone.

Give permissions:

```text
Settings
→ Accessibility
→ Installed apps
→ MacroDroid
→ On
```

```text
Settings
→ Apps
→ MacroDroid
→ Battery
→ Unrestricted
```

Create a MacroDroid macro.

Trigger:

```text
Regular Interval
Every 1 minute
```

Action:

```text
HTTP Request
Method: GET
URL: https://YOUR_RENDER_URL/api/phone-sms?token=YOUR_DASHBOARD_TOKEN
```

The server returns:

```json
{
  "ok": true,
  "pending": true,
  "to": "+65xxxxxxxx",
  "message": "Bus 61 arrives at 11299 in 10 min. ETA 14:12."
}
```

If `pending` is `true`, send SMS:

```text
Send SMS
Phone number: to
Message: message
```

If `pending` is `false`, do nothing.

Home reminders are generated only from `14:00`, and only for:

```text
15, 10, 8, 5, 3, 1 minutes before bus arrival
```

## 7. Galaxy Tab Dashboard

Open the Render URL on the Galaxy Tab:

```text
https://YOUR_RENDER_URL?token=YOUR_DASHBOARD_TOKEN
```

In Chrome:

```text
Menu
→ Add to Home screen
```

Tap `Enable voice` to allow voice alerts.

Tap `Disable voice` to stop voice alerts.

## 8. Xiaomi Kids Automation Later

This is optional and should be added after regular SMS works.

Enable in Render:

```env
ENABLE_XIAOMI_MESSAGE=true
```

MacroDroid should poll:

```text
https://YOUR_RENDER_URL/api/xiaomi-message?token=YOUR_DASHBOARD_TOKEN
```

If `pending` is `true`, MacroDroid should:

```text
Open Xiaomi Kids
Open child chat
Paste message
Tap Send
```

SMS and Xiaomi use separate queues, so one does not consume the other's message.

## 9. Common Problems

If LTA data does not load:

```text
Check LTA_ACCOUNT_KEY
Check Render Environment variables
Restart Render service
```

If the page asks for access code:

```text
Use DASHBOARD_TOKEN
```

If phone cannot open local laptop URL:

```text
Use HOST=0.0.0.0
Use laptop LAN IP, not 127.0.0.1
Make sure both devices are on the same Wi-Fi
```

If Render URL keeps loading:

```text
Check Render Logs
Check Start Command: npm start
Check HOST=0.0.0.0
```

## 10. Important Security Notes

Never share:

```text
LTA_ACCOUNT_KEY
DASHBOARD_TOKEN
.env
```

Do not commit `.env`.

