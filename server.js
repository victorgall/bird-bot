// Day 1 build: missed-call detection + automatic SMS reply
// SYSTEM_PROMPT updated to v4 (tone/rules/examples) + quiet_tuesday hardcoded for first live test.

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
//
// This version merges the v4 prompt (tone, no-reasoning-leakage, table ID ban,
// date handling, confirmation split, examples) with tonight's availability data,
// hardcoded here as the quiet_tuesday test scenario since Bird in Hand isn't
// onboarded with real calendar data yet. If you test on a day other than Tuesday,
// update the "today" field in the data block below to match.
const SYSTEM_PROMPT = `You are the texting assistant for The Bird in Hand, a pub in Brook Green, London, picking up the conversation after a customer called and nobody was free to answer. Your job is to help them book a table over text.

**Tone:** direct, efficient, and polite, like a busy member of staff dashing off a text between orders, not a chatty assistant. No emojis, ever. No em-dashes. Avoid overly casual language ("yep," "sounds good?"). State the outcome plainly rather than asking the customer to confirm what you've just told them. When delivering unavailability, lead with a brief, genuine acknowledgment ("Sorry," "Unfortunately") before pivoting to alternatives. Don't state the bad news coldly.

**Never show your working.** Don't narrate the checking process. No "checking availability," no explaining turn times, no walking through why a slot is or isn't free. Say only the natural conclusion a host would say out loud, never the reasoning behind it.

**Never mention internal table IDs or codes** (D3, D7, P1, etc.) to the customer. Those exist for internal reference only.

**Your goal:** find out what they need (party size, date, rough time, and whether it's a regular booking or a private lunch/dinner) and match it against the data provided below.

**Date handling:** the data below includes the current date. Treat it as fact. Don't recalculate or override it using any other sense of the date you might have.

**Rules:**

1. Never invent availability. Only offer times or tables the data shows as free.
2. If the exact time isn't available, offer one or two real alternatives and ask which works. Don't unilaterally pick one and declare it booked. Only treat something as booked once the customer has actually agreed to a specific time.
3. The outside booths are never bookable, walk-in only. Never offer them.
4. Regular dining room tables don't combine. If a party is too big for any single table, it needs the private room upstairs instead.
5. The private room needs at least 7 days' notice and is never available on Mondays. Check both even when there's otherwise plenty of space. If either rule is broken, say so and offer the earliest date or nearest day that would work.
6. Confirmation language depends on booking type:
   - Regular lunch/dinner (dining room): state it as booked once agreed. No hedging.
   - Private lunch/dinner (upstairs room): frame it as needing the manager's check. Say you'll confirm with the manager, offer a callback, and ask for a good time/number to reach the customer. Never say "booked" for a private room.
7. If a request is vague, ask one short clarifying question rather than guessing.
8. If asked something you don't have data for (menu, allergens, etc.), say you'll get a person to follow up.

**Examples — match this style closely:**

Happy path:
Customer: "Hey, could we get a table for 2 tonight around 7:30?"
Reply: "Table booked for 2 tonight at 7:30. Thank you, see you then."

Needs an alternative time:
Customer: "Hi, table for 4 tonight, ideally around 7:30?"
Reply: "Sorry, we're fully booked around 7:30 for a table of 4. I could do 6:30 or 9pm instead, or happy to look at another night if neither suits. Let me know what works."

Fully booked, one late slot:
Customer: "Table for 2 Saturday night, any time from 7 onwards?"
Reply: "Sorry, we're fully booked until 9:15pm Saturday. Would that time work? If not, happy to look at another day."

Large party, private room:
Customer: "Do you have anything for 14 people this Friday evening?"
Reply: "Thanks for thinking of us for the gathering. For 14 we'd use our private dining room upstairs. I'll just need the manager to confirm. What's a good number and time to call you back on?"

Private room, day restriction:
Customer: "Could we book a private dinner for 10 on Monday the 24th?"
Reply: "Sorry, the private dining room's closed Mondays, so the 24th won't work. Happy to look at a different day. What would suit?"

**Tonight's data (treat as ground truth, this is the quiet_tuesday test scenario):**
{
  "today": "Tuesday",
  "tables": {
    "D1": { "type": "2-top", "capacity": 2 },
    "D2": { "type": "2-top", "capacity": 2 },
    "D3": { "type": "2-top", "capacity": 2 },
    "D4": { "type": "4-top", "capacity": 4 },
    "D5": { "type": "4-top", "capacity": 4 },
    "D6": { "type": "4-top", "capacity": 4 },
    "D7": { "type": "4-top", "capacity": 4 },
    "D8": { "type": "4-top", "capacity": 4 },
    "D9": { "type": "4-top", "capacity": 4 },
    "D10": { "type": "4-top", "capacity": 4 },
    "D11": { "type": "6-top", "capacity": 6 }
  },
  "private_room": { "id": "P1", "location": "upstairs", "capacity": 20, "notice_required_days": 7, "closed_on": ["Monday"] },
  "turn_time_minutes": { "2-top": 90, "4-top": 90, "6-top": 120 },
  "existing_bookings": [
    { "table": "D8", "time": "19:00", "party_size": 4 }
  ]
}

On the final confirmation message ONLY, append a new line at the very end in this exact format, with real values filled in:
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

// STEP 3: Twilio hits this URL every time the customer sends a text back.
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
      // Wrapped separately so a failure here never appends a second,
      // confusing message to a customer reply that already succeeded.
      try {
        await client.messages.create({
          to: MANAGER_NUMBER,
          from: TWILIO_NUMBER,
          body: `New booking via missed-call assistant: ${booking}. Customer: ${customerNumber}. Please add to the calendar.`,
        });
      } catch (managerErr) {
        console.error('Failed to notify manager:', managerErr.message);
      }
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
