// Missed-call detection + AI booking conversation, backed by a real
// (in-memory) availability engine instead of a hardcoded rule in the prompt.

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const availability = require('./availability');

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

// Seed the demo availability state (Saturday full, Tuesday open) every time
// the server starts — including Render cold starts — so it's never stale.
availability.seedDemoData();

// Very simple in-memory conversation history, keyed by the customer's phone number.
// This resets if Render restarts the server — fine for a prototype, not for production.
const conversations = {};

// Tool definition Claude uses to check real availability instead of guessing.
const AVAILABILITY_TOOL = {
  name: 'check_availability',
  description: 'Check whether the venue can seat a given party size at a given date and time. Always call this before telling a customer whether a time is available — never guess.',
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Date in YYYY-MM-DD format, taken from the date list in the system prompt.' },
      time: { type: 'string', description: 'Time in 24-hour HH:MM format, e.g. 19:00. If the customer gave no exact time, use 13:00 for lunch or 19:00 for dinner.' },
      partySize: { type: 'integer', description: 'Number of people in the party.' },
      isPrivateRoom: { type: 'boolean', description: 'True only if they specifically asked for the private dining room.' },
    },
    required: ['date', 'time', 'partySize'],
  },
};

// Tool Claude uses to find REAL alternatives when a requested time is
// unavailable, instead of guessing a nearby time and finding out it's also
// full. Returns up to 2 genuinely available slots.
const FIND_ALTERNATIVES_TOOL = {
  name: 'find_alternative_times',
  description: 'Use this whenever check_availability comes back unavailable, BEFORE saying anything to the customer about alternatives. Returns real available slots near the requested time, so you never offer a time that turns out to also be full.',
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'The originally requested date, YYYY-MM-DD.' },
      time: { type: 'string', description: 'The originally requested time, HH:MM.' },
      partySize: { type: 'integer', description: 'Number of people in the party.' },
      isPrivateRoom: { type: 'boolean', description: 'True only if they specifically asked for the private dining room.' },
    },
    required: ['date', 'time', 'partySize'],
  },
};

// Builds the system prompt fresh each turn so the date list is always current.
function buildSystemPrompt() {
  const dateContext = availability.getUpcomingDates(14)
    .map((d) => `${d.dayName} ${d.date}`)
    .join('\n');

  return `You are a booking assistant texting on behalf of The Bird in Hand, a pub in Brook Green, London, known for pizza and Mediterranean small plates, with a private dining space for celebrations.

Someone just called and couldn't get through (the pub was busy), so you're texting them back. Be warm, brief, and human — like a friendly staff member, not a corporate bot. Use short sentences. No emojis, no em-dashes. Don't narrate your reasoning to the customer.

Today's date and the next 14 days are:
${dateContext}

When the customer mentions a day (like "Saturday"), match it against this list to get the exact date. Never calculate or guess dates yourself.

Your job:
1. Find out what they want: party size, date, time, and occasion if mentioned.
2. Once you have party size and date (and roughly a time — assume 13:00 for lunch or 19:00 for dinner if they don't give one), call the check_availability tool. Never state availability without calling the tool first.
3. If check_availability says unavailable, do NOT guess or suggest a time yourself. Call find_alternative_times first to get real options, then apologise briefly in one short sentence and offer those specific options as a question. Never mention a time to the customer that you have not confirmed is available.
4. Once they confirm a specific time the tool has confirmed as available, thank them and confirm the booking in one friendly message.
5. On that final confirmation message ONLY, append a new line at the very end in this exact format, with real values filled in and separated by "|":
[BOOKING_CONFIRMED|<partySize>|<date>|<time>|<name or "not given">|<occasion or "not given">]
Do not include this line in any message except the final confirmation. Never mention this line to the customer or explain it — it is only for internal system use.

Never mention table numbers or any internal system details. If they ask about the private dining room, always say it's pending manager confirmation rather than confirming it outright — never send a [BOOKING_CONFIRMED] line for a private room request.`;
}

// Looks for the hidden [BOOKING_CONFIRMED ...] marker, strips it from the customer-facing
// text, and returns the clean text plus the parsed booking details if present.
function extractBooking(replyText) {
  const match = replyText.match(/\[BOOKING_CONFIRMED\|([^\]]*)\]/);
  if (!match) {
    return { cleanText: replyText, booking: null };
  }
  const cleanText = replyText.replace(match[0], '').trim();
  const [partySize, date, time, name, occasion] = match[1].split('|').map((s) => s.trim());
  return { cleanText, booking: { partySize: Number(partySize), date, time, name, occasion } };
}

// Calls Claude with the full conversation so far, handling any tool calls it
// makes along the way, and returns its final reply text.
async function getAssistantReply(phoneNumber, customerMessage) {
  if (!conversations[phoneNumber]) {
    conversations[phoneNumber] = [];
  }
  const history = conversations[phoneNumber];
  history.push({ role: 'user', content: customerMessage });

  const systemPrompt = buildSystemPrompt();

  const tools = [AVAILABILITY_TOOL, FIND_ALTERNATIVES_TOOL];

  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 300,
    system: systemPrompt,
    messages: history,
    tools,
  });

  // Claude may call tools more than once in a turn (e.g. check Saturday 7pm,
  // find alternatives, then check the customer's chosen alternative). Cap
  // the loop so a stuck request can't run forever.
  let toolRoundTrips = 0;
  while (response.stop_reason === 'tool_use' && toolRoundTrips < 4) {
    toolRoundTrips += 1;
    history.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      let result;
      const { date, time, partySize, isPrivateRoom } = block.input;

      if (block.name === 'check_availability') {
        result = availability.checkAvailability(date, time, partySize, !!isPrivateRoom);
      } else if (block.name === 'find_alternative_times') {
        result = { alternatives: availability.findAlternatives(date, time, partySize, !!isPrivateRoom) };
      } else {
        result = { error: `Unknown tool: ${block.name}` };
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    history.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: history,
      tools,
    });
  }

  const replyText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  history.push({ role: 'assistant', content: replyText });
  return replyText;
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
// This is the actual AI conversation loop, now backed by real availability checks.
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

      // Record it in the availability store so it counts against remaining
      // capacity for any later checks in this same server run.
      availability.addBooking({
        date: booking.date,
        time: booking.time,
        partySize: booking.partySize,
        isPrivateRoom: false,
      });

      // Fire off a separate text to the manager with the clean summary.
      // This is the "human confirms it" step, since we don't have live
      // calendar-write access to the venue's actual booking system yet.
      await client.messages.create({
        to: MANAGER_NUMBER,
        from: TWILIO_NUMBER,
        body: `New booking via missed-call assistant: ${booking.partySize} people, ${booking.date} at ${booking.time}. Name: ${booking.name}. Occasion: ${booking.occasion}. Customer: ${customerNumber}. Please add to the calendar.`,
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
