// Day 1 build: missed-call detection + automatic SMS reply
// No AI yet — that comes on Day 3. Today is just the plumbing.

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// --- Config: set these in Render's Environment Variables, never hardcode them ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;       // the Twilio number you bought, e.g. +44...
const FORWARD_TO_NUMBER = process.env.FORWARD_TO_NUMBER; // YOUR real phone, for testing this week

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
