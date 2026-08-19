// availability.js
// Bird in Hand — availability engine (aggregate capacity model)
//
// Lightweight stand-in for real-time availability: tracks total covers
// booked per time slot against total capacity, rather than managing
// individual tables. Designed to be swapped out later for Google Calendar
// (or OpenTable — confirm which one Max actually uses) reads without
// changing the checkAvailability() interface the rest of the app calls.

const CONFIG = {
  totalCapacity: 40,        // total covers across main dining area
  privateRoomCapacity: 14,  // seats in the private room (always pending manager confirmation)
  turnTimeMinutes: 90,      // average time a table is occupied per booking
  serviceHours: {
    monday:    [{ start: '12:00', end: '15:00' }, { start: '18:00', end: '21:30' }],
    tuesday:   [{ start: '12:00', end: '15:00' }, { start: '18:00', end: '21:30' }],
    wednesday: [{ start: '12:00', end: '15:00' }, { start: '18:00', end: '21:30' }],
    thursday:  [{ start: '12:00', end: '15:00' }, { start: '18:00', end: '21:30' }],
    friday:    [{ start: '12:00', end: '15:00' }, { start: '18:00', end: '22:00' }],
    saturday:  [{ start: '12:00', end: '22:00' }],
    sunday:    [{ start: '12:00', end: '17:00' }],
  },
};

// In-memory bookings store. Resets on every server restart (including Render
// cold starts) — fine for the pilot demo, needs a real DB before going live
// with actual customers.
// Each booking: { date: 'YYYY-MM-DD', time: 'HH:MM', partySize: N, isPrivateRoom: bool }
let bookings = [];

function toMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function overlaps(bookingTime, checkTime) {
  return Math.abs(toMinutes(bookingTime) - toMinutes(checkTime)) < CONFIG.turnTimeMinutes;
}

function isWithinServiceHours(date, time) {
  const day = new Date(date).toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase();
  const windows = CONFIG.serviceHours[day] || [];
  return windows.some(w => time >= w.start && time <= w.end);
}

function getBookedCoversAtSlot(date, time, isPrivateRoom = false) {
  return bookings
    .filter(b => b.date === date && b.isPrivateRoom === isPrivateRoom && overlaps(b.time, time))
    .reduce((sum, b) => sum + b.partySize, 0);
}

// Main function the app calls. Returns whether a party can be booked at this
// date/time, plus how many covers are left in that slot.
function checkAvailability(date, time, partySize, isPrivateRoom = false) {
  if (!isWithinServiceHours(date, time)) {
    return { available: false, reason: 'outside_service_hours' };
  }
  const capacity = isPrivateRoom ? CONFIG.privateRoomCapacity : CONFIG.totalCapacity;
  const booked = getBookedCoversAtSlot(date, time, isPrivateRoom);
  const remaining = capacity - booked;
  return {
    available: remaining >= partySize,
    remaining,
    capacity,
    reason: remaining >= partySize ? null : 'fully_booked',
  };
}

function addBooking(booking) {
  bookings.push(booking);
}

// Scans forward from (date, time) — same day first, prioritising times close
// to the original request, then subsequent days — and returns real available
// slots. This exists so Claude never has to guess a candidate time; it asks
// for genuine alternatives instead.
function findAlternatives(date, time, partySize, isPrivateRoom = false, maxSuggestions = 2, maxDaysAhead = 7) {
  const suggestions = [];
  const startDate = new Date(date);

  function candidateTimesForDate(dateStr) {
    const day = new Date(dateStr).toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase();
    const windows = CONFIG.serviceHours[day] || [];
    const times = [];
    for (const w of windows) {
      let cursor = toMinutes(w.start);
      const end = toMinutes(w.end);
      while (cursor <= end) {
        const hh = String(Math.floor(cursor / 60)).padStart(2, '0');
        const mm = String(cursor % 60).padStart(2, '0');
        times.push(`${hh}:${mm}`);
        cursor += 30;
      }
    }
    return times;
  }

  for (let dayOffset = 0; dayOffset <= maxDaysAhead && suggestions.length < maxSuggestions; dayOffset++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + dayOffset);
    const dateStr = d.toISOString().split('T')[0];
    let times = candidateTimesForDate(dateStr);

    if (dayOffset === 0) {
      times = times
        .filter((t) => t !== time)
        .sort((a, b) => Math.abs(toMinutes(a) - toMinutes(time)) - Math.abs(toMinutes(b) - toMinutes(time)));
    }

    for (const t of times) {
      const result = checkAvailability(dateStr, t, partySize, isPrivateRoom);
      if (result.available) {
        suggestions.push({ date: dateStr, time: t });
        if (suggestions.length >= maxSuggestions) break;
      }
    }
  }

  return suggestions;
}

// Resolves a day name (e.g. "saturday") to the next real calendar date after
// fromDate, in YYYY-MM-DD format. Always returns the NEXT occurrence, never today.
function getDateForUpcomingDay(dayName, fromDate = new Date()) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const targetIndex = days.indexOf(dayName.toLowerCase());
  const from = new Date(fromDate);
  let diff = targetIndex - from.getDay();
  if (diff <= 0) diff += 7;
  const result = new Date(from);
  result.setDate(from.getDate() + diff);
  return result.toISOString().split('T')[0];
}

// Returns the next N days as { dayName, date } pairs, starting today.
// This is what gets fed into the Claude system prompt so it never has to
// calculate dates itself.
function getUpcomingDates(daysAhead = 14, fromDate = new Date()) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dates = [];
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(fromDate);
    d.setDate(fromDate.getDate() + i);
    dates.push({ dayName: dayNames[d.getDay()], date: d.toISOString().split('T')[0] });
  }
  return dates;
}

// Fills the next Saturday's dinner service to full capacity and leaves the
// next Tuesday open. Runs automatically on server start so the demo is
// always in the right state regardless of what day you actually pitch on.
function seedDemoData() {
  bookings = [];
  const saturdayDate = getDateForUpcomingDay('saturday');
  bookings.push({
    date: saturdayDate,
    time: '19:00',
    partySize: CONFIG.totalCapacity,
    isPrivateRoom: false,
  });
  console.log(`Demo data seeded: ${saturdayDate} (Saturday) dinner is FULL. Next Tuesday is open.`);
}

module.exports = {
  CONFIG,
  checkAvailability,
  findAlternatives,
  addBooking,
  bookings,
  getDateForUpcomingDay,
  getUpcomingDates,
  seedDemoData,
};
