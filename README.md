# Singapore Bus Alert

Home dashboard for children commute reminders using LTA Bus Arrival.

## Current routes

- Weekday: bus 61, `14131` to `11291`, deadline `06:45`
- Weekday home: bus 61, `11299` to `14139`, active `13:50-14:30`
- Saturday morning: bus 97, `14131` to `28301`, deadline `08:45`
- Saturday afternoon: buses 143, 30, 10, 188, `14131` to `16061`, deadline `16:00`

Alerts are sent 15, 10, and 8 minutes before the bus reaches the origin stop.

## Setup

1. Copy `.env.example` to `.env`.
2. Put your LTA DataMall AccountKey in `.env`.
3. Set a long random `DASHBOARD_TOKEN`.
3. Start the dashboard.

```sh
npm start
```

Open:

```text
http://localhost:3100
```

Sample screen:

```text
http://localhost:3100?sample=1
```

If the dashboard runs on another computer and Galaxy Tab A7 connects over Wi-Fi, set `HOST=0.0.0.0` in `.env`, restart the server, and open:

```text
http://YOUR_COMPUTER_LAN_IP:3100
```

On Galaxy Tab A7, open the URL in Chrome and tap `Enable voice` once after loading the page. Android browsers require a tap before speech is allowed.

If `DASHBOARD_TOKEN` is set, open the dashboard with:

```text
http://localhost:3100?token=YOUR_DASHBOARD_TOKEN
```

The browser stores the token in local storage after the first successful load.

## LTA key

Only this key is needed for the first version:

```text
LTA_ACCOUNT_KEY
```

Get it from:

```text
https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html
```

Do not commit `.env`.

## Notification channels

Implemented now:

- Tablet dashboard
- Tablet English voice alerts

Planned next:

- Deploy the server to Render
- Send regular SMS from a phone with MacroDroid
- Optional: Xiaomi Kids app automation later

## Render Deployment

The server should run in the cloud first. Render will run this Node app and give it a public HTTPS URL.

1. Push this project to GitHub.
2. In Render, create a new `Web Service`.
3. Connect the GitHub repository.
4. Use these commands:

```text
Build Command: npm install
Start Command: npm start
```

5. Add these environment variables in Render:

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

Do not put secret values into `render.yaml`.

After deployment, Render gives a URL like:

```text
https://singapore-bus-alert.onrender.com
```

Open the dashboard:

```text
https://singapore-bus-alert.onrender.com?token=YOUR_DASHBOARD_TOKEN
```

## MacroDroid Phone SMS

Home-trip reminders are configured for the weekday route:

```text
11299 -> 14139
Bus 61
13:50-14:30
reminders start at 14:00
```

It creates messages only at these bus-arrival countdown points:

```text
15, 10, 8, 5, 3, 1 minutes
```

Server settings:

```env
ENABLE_HOME_SMS=true
SMS_DELIVERY=phone
ENABLE_XIAOMI_MESSAGE=false
SMS_POLL_INTERVAL_SECONDS=60
SMS_TO_NUMBER=+65xxxxxxxx
```

Use MacroDroid on your phone to poll this endpoint every 1 minute:

```text
https://YOUR_RENDER_URL/api/phone-sms?token=YOUR_DASHBOARD_TOKEN
```

The endpoint returns JSON.

If `pending` is `true`, MacroDroid should send a regular SMS:

```json
{
  "pending": true,
  "to": "+65xxxxxxxx",
  "message": "Bus 61 arrives at 11299 in 10 min. ETA 14:12."
}
```

If `pending` is `false`, there is no SMS to send.

Recommended MacroDroid flow:

```text
Trigger: Regular Interval, every 1 minute
Action: HTTP Request GET https://YOUR_RENDER_URL/api/phone-sms?token=YOUR_DASHBOARD_TOKEN
Condition: pending == true
Action: Send SMS
Phone number: response field `to`
Message: response field `message`
```

The phone must have a SIM card and SMS sending permission.

## MacroDroid Xiaomi Kids

This is the third step, after cloud deployment and regular phone SMS work.

Enable it with:

```env
ENABLE_XIAOMI_MESSAGE=true
```

Use a separate MacroDroid macro to poll:

```text
https://YOUR_RENDER_URL/api/xiaomi-message?token=YOUR_DASHBOARD_TOKEN
```

If `pending` is `true`, MacroDroid should open Xiaomi Kids, open the child chat, paste the returned `message`, and tap Send.

`/api/phone-sms` and `/api/xiaomi-message` use separate queues, so SMS and Xiaomi messages do not consume each other's reminders.

## Twilio SMS

Twilio delivery is optional and currently not needed when MacroDroid sends Xiaomi Kids messages.
To use Twilio later, set:

```env
SMS_DELIVERY=twilio
SMS_TO_NUMBER=+6583383952
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM_NUMBER=+1xxxxxxxxxx
```

After restarting the server, test locally:

```text
http://127.0.0.1:3100/api/test-sms?token=YOUR_DASHBOARD_TOKEN
```

The test endpoint is local-only. Cloud deployments should use environment variables for Twilio secrets and should not commit them.

## Security

Keep these values only in `.env` or cloud environment variables:

```text
LTA_ACCOUNT_KEY
DASHBOARD_TOKEN
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_FROM_NUMBER
SMS_TO_NUMBER
```

For cloud deployment:

```env
ALLOW_SYSTEM_VOICE=false
```

The `/api/status` and `/api/config` endpoints require the dashboard token when it is configured.
The `/api/say` endpoint is local-only and disabled unless `ALLOW_SYSTEM_VOICE=true`.

## Calibration

The weekday 61 route starts with a conservative travel range of 27 to 40 minutes.
Saturday morning 97 starts at 53 minutes.
Saturday afternoon travel time is not configured yet because it still needs a measured estimate from `14131` to `16061`.
