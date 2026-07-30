# Bird in Hand Bot — Day 1

This is the Day 1 build: when someone calls your Twilio number and it goes unanswered,
they automatically get a text back. No AI yet — that's Day 3.

## How it works
1. Someone calls your Twilio number
2. Twilio forwards the call to YOUR real phone (so you control whether it's "answered" while testing)
3. If you don't pick up within 15 seconds, Twilio tells the server, which texts the caller automatically

## Setup steps

### 1. Deploy this code to Render
- Create a free GitHub account if you don't have one, and a new repository (e.g. "bird-in-hand-bot")
- Upload these three files (server.js, package.json, this README) to that repository
- Go to render.com, click "New +" → "Web Service"
- Connect your GitHub account and select the repository
- Settings: Build Command = `npm install`, Start Command = `npm start`
- Click "Create Web Service" — Render will give you a URL like `https://bird-in-hand-bot.onrender.com`

### 2. Add your environment variables in Render
In the Render dashboard for this service, go to "Environment" and add:
- `TWILIO_ACCOUNT_SID` — found on your Twilio console homepage
- `TWILIO_AUTH_TOKEN` — also on your Twilio console homepage (click "show" to reveal it)
- `TWILIO_NUMBER` — the Twilio number you bought, in the format +44...
- `FORWARD_TO_NUMBER` — YOUR real phone number, in the format +44..., so calls forward to you for testing

Save, and Render will redeploy automatically.

### 3. Point your Twilio number at this server
- In the Twilio console, go to Phone Numbers → Manage → Active Numbers → click your number
- Scroll to "Voice Configuration"
- Under "A call comes in", set it to: Webhook, and paste in `https://your-render-url.onrender.com/voice`
- Make sure the method is set to HTTP POST
- Save

### 4. Test it
- Call your Twilio number from a different phone (e.g. a friend's, or a second SIM)
- Let your own phone ring and DON'T answer it
- After about 15 seconds, the phone that called should receive an automatic text

If that text arrives, Day 1 is done — the entire plumbing works end to end.

### If something doesn't work
- Check the "Logs" tab in Render — it'll show exactly what happened (or didn't)
- Double check the phone numbers are in full international format (+44 not 07...)
- Make sure both Voice and SMS were ticked as capabilities when you bought the Twilio number

## Day 3 — the AI conversation layer

The code now handles a full back-and-forth text conversation using Claude, not just a single static reply.

### New environment variables to add in Render
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `MANAGER_NUMBER` — the phone number that should receive the final booking summary (can be the same as `FORWARD_TO_NUMBER` while you're the only one testing)

### New Twilio webhook to set up
Just like you did for the Voice webhook, go to your number's settings in Twilio and find the **Messaging Configuration** section. Set "A message comes in" to Webhook, paste in:
`https://your-render-url.onrender.com/sms`
Method: HTTP POST. Save.

### How the conversation logic works
- Every text the customer sends triggers `/sms`, which sends the whole conversation so far to Claude and gets a reply.
- The AI is told (via the SYSTEM_PROMPT in server.js) to treat Friday/Saturday 7-8:30pm as fully booked and offer alternatives — this is placeholder logic standing in for a real calendar until Bird in Hand can grant DesignMyNight API access.
- When the AI finalizes a booking, it appends a hidden marker to its own reply. The code detects this, strips it out of what the customer sees, and sends a separate clean summary text to `MANAGER_NUMBER` for manual entry into the real booking system.
- Conversations are stored in memory per phone number — this resets if Render restarts the server, which is fine for testing but worth knowing.
