// Day 1 build: missed-call detection + automatic SMS reply
// No AI yet — that comes on Day 3. Today is just the plumbing.

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// --- Config: set these in Render's Environment Variables, never hardcode them ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;       // the Twilio number you bought, e.g. +44...
const FORWARD_TO_NUMBER = process.env.FORWARD_TO_NUMBER; // YOUR real phone, for testing this week
const MANAGER_NUMBER = process.env.MANAGER_NUMBER || FORWARD_TO_NUMBER; // who gets the booking summary
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Very simple in-memory conversation history, keyed by the customer's phone number.
// This resets if Render restarts the server — fine for a prototype, not for production.
const conversations = {};

// This is the AI's entire personality and instructions. Tweak this text to change
// how it behaves — no other code changes needed for most adjustments.
const SYSTEM_PROMPT = `You are a booking assistant texting on behalf of The Bird in Hand, a pub in Brook Green, London, known for pizza and Mediterranean small plates, with a private dining space for celebrations.

Someone just called and couldn't get through (the pub was busy), so you're texting them back. Be warm, brief, and human — like a friendly staff member, not a corporate bot. Use short sentences. No emojis.

Your job:
1. Find out what they want: party size, date, time, and occasion if mentioned.
2. Check availability using this rule (this is placeholder logic until the real booking system is connected): Friday and Saturday evenings between 7:00pm and 8:30pm are FULLY BOOKED. Every other time and day is available.
3. If their requested time is unavailable, apologise briefly and offer two nearby alternative times that ARE available (e.g. earlier or later that evening).
4. Once they confirm a time that works, thank them and confirm the booking in one friendly message.
5. On that final confirmation message ONLY, append a new line at the very end in this exact format, with real values filled in:
[BOOKING_CONFIRMED partySize=<number> date=<date> time=<time> name=<name or "not given"> occasion=<occasion or "not given">]
Do not include this line in any message except the final confirmation. Never mention this line to the customer or explain it — it is only for internal system use.`;

// Calls Claude with the full conversation so far and returns its reply text.
async function getAssistantReply(phoneNumber, customerMessage) {
  if (!conversations[phoneNumber]) {
    conversations[phoneNumber] = [];
  }
  const history = conversations[phoneNumber];
  history.push({ role: 'user', content: customerMessage });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: history,
  });

  const replyText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  history.push({ role: 'assistant', content: replyText });
  return replyText;
}

// Looks for the hidden [BOOKING_CONFIRMED ...] marker, strips it from the customer-facing
// text, and returns the clean text plus the booking details if present.
function extractBooking(replyText) {
  const match = replyText.match(/\[BOOKING_CONFIRMED([^\]]*)\]/);
  if (!match) {
    return { cleanText: replyText, booking: null };
  }
  const cleanText = replyText.replace(match[0], '').trim();
  return { cleanText, booking: match[1].trim() };
}

// Simple health check so you can confirm the server is alive from a browser
app.get('/', (req, res) => {
  res.send('Bird in Hand bot is running.');
});

// STEP 1: Twilio hits this URL the moment someone calls your Twilio number.
// We forward the call to your real phone so you can choose to answer or ignore it while testing.
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const dial = twiml.dial({
    timeout: 15,           // rings for 15 seconds before giving up
    action: '/call-status', // Twilio calls this URL next, telling us what happened
  });
  dial.number(FORWARD_TO_NUMBER);

  res.type('text/xml');
  res.send(twiml.toString());
});

// STEP 2: Twilio tells us here how the forwarded call ended.
// If it wasn't answered, we text the original caller automatically.
app.post('/call-status', async (req, res) => {
  const dialCallStatus = req.body.DialCallStatus; // e.g. 'completed', 'no-answer', 'busy', 'failed'
  const callerNumber = req.body.Caller;           // the customer's number, provided by Twilio

  console.log(`Call ended with status: ${dialCallStatus}, caller: ${callerNumber}`);

  const missed = ['no-answer', 'busy', 'failed'].includes(dialCallStatus);

  if (missed && callerNumber) {
    try {
      await client.messages.create({
        to: callerNumber,
        from: TWILIO_NUMBER,
        body: "Hi, sorry we missed your call, we're mid-service! This is the Bird in Hand's booking assistant — what can I help with?",
      });
      console.log('Missed-call text sent to', callerNumber);
    } catch (err) {
      console.error('Failed to send SMS:', err.message);
    }
  }

  // Tell Twilio the call is over — nothing more to say to the caller on the voice line
  const twiml = new twilio.twiml.VoiceResponse();
  res.type('text/xml');
  res.send(twiml.toString());
});

// STEP 3 (Day 3): Twilio hits this URL every time the customer sends a text back.
// This is the actual AI conversation loop.
app.post('/sms', async (req, res) => {
  const customerMessage = req.body.Body;
  const customerNumber = req.body.From;

  console.log(`Incoming SMS from ${customerNumber}: ${customerMessage}`);

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const rawReply = await getAssistantReply(customerNumber, customerMessage);
    const { cleanText, booking } = extractBooking(rawReply);

    twiml.message(cleanText);

    if (booking) {
      console.log('Booking confirmed:', booking);
      // Fire off a separate text to the manager with the clean summary.
      // This is the "human confirms it" step, since we don't have live
      // calendar-write access to the venue's actual booking system yet.
      await client.messages.create({
        to: MANAGER_NUMBER,
        from: TWILIO_NUMBER,
        body: `New booking via missed-call assistant: ${booking}. Customer: ${customerNumber}. Please add to the calendar.`,
      });
    }
  } catch (err) {
    console.error('Error getting AI reply:', err.message);
    twiml.message("Sorry, having a technical hiccup — someone will call you back shortly!");
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
