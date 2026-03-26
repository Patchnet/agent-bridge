'use strict';

/**
 * calendar.js — Calendar bridge tools.
 *
 * Discrete, validated operations for calendar management via Microsoft Graph.
 * All functions are thin wrappers around graphRequest().
 */

const { graphRequest } = require('./graph');
const { registerTool } = require('./tools');

// ── Tool implementations ────────────────────────────────────────────────

/**
 * List upcoming calendar events.
 * @param {{ top?: number, start?: string, end?: string }} params
 */
async function getEvents({ top = 25, start, end, userId } = {}) {
  const target = userId ? `/users/${encodeURIComponent(userId)}` : '/me';
  const select = '$select=id,subject,start,end,location,attendees,isOnlineMeeting,onlineMeetingUrl,bodyPreview,organizer';
  if (start && end) {
    const data = await graphRequest('GET',
      `${target}/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=${top}&$orderby=start/dateTime&${select}`
    );
    return data.value || [];
  }
  const data = await graphRequest('GET',
    `${target}/events?$top=${top}&$orderby=start/dateTime&${select}`
  );
  return data.value || [];
}

/**
 * Get details of a specific event.
 * @param {{ eventId: string, userId?: string }} params
 */
async function getEvent({ eventId, userId }) {
  const target = userId ? `/users/${encodeURIComponent(userId)}` : '/me';
  return graphRequest('GET', `${target}/events/${eventId}?$select=id,subject,start,end,location,attendees,body,isOnlineMeeting,onlineMeetingUrl,organizer,recurrence`);
}

/**
 * Smart meeting time suggestions via findMeetingTimes.
 * @param {{ attendees: string[], startRange: string, endRange: string, duration: string }} params
 */
async function findFreeTime({ attendees, startRange, endRange, duration }) {
  const body = {
    attendees: attendees.map(email => ({
      type: 'required',
      emailAddress: { address: email },
    })),
    timeConstraint: {
      activityDomain: 'work',
      timeSlots: [{
        start: { dateTime: startRange, timeZone: 'UTC' },
        end: { dateTime: endRange, timeZone: 'UTC' },
      }],
    },
    meetingDuration: duration,
    maxCandidates: 5,
    isOrganizerOptional: false,
    returnSuggestionReasons: true,
  };
  return graphRequest('POST', '/me/findMeetingTimes', body);
}

/**
 * Raw free/busy blocks for one or more users.
 * @param {{ users: string[], start: string, end: string }} params
 */
async function getSchedule({ users, start, end }) {
  const body = {
    schedules: users,
    startTime: { dateTime: start, timeZone: 'UTC' },
    endTime: { dateTime: end, timeZone: 'UTC' },
    availabilityViewInterval: 30,
  };
  return graphRequest('POST', '/me/calendar/getSchedule', body);
}

/**
 * Create a calendar event (auto-sends invites to attendees).
 * @param {{ subject: string, start: string, end: string, attendees?: string[], body?: string, location?: string, isOnlineMeeting?: boolean }} params
 */
async function createMeeting({ subject, start, end, attendees = [], body = '', location = '', isOnlineMeeting = false, userId }) {
  const target = userId ? `/users/${encodeURIComponent(userId)}` : '/me';
  const event = {
    subject,
    start: { dateTime: start, timeZone: 'UTC' },
    end: { dateTime: end, timeZone: 'UTC' },
    isOnlineMeeting,
  };
  if (attendees.length > 0) {
    event.attendees = attendees.map(email => ({
      emailAddress: { address: email },
      type: 'required',
    }));
  }
  if (body) {
    event.body = { contentType: 'text', content: body };
  }
  if (location) {
    event.location = { displayName: location };
  }
  if (isOnlineMeeting) {
    event.onlineMeetingProvider = 'teamsForBusiness';
  }
  return graphRequest('POST', `${target}/events`, event);
}

/**
 * Update an existing calendar event.
 * @param {{ eventId: string, subject?: string, start?: string, end?: string, attendees?: string[], body?: string, location?: string }} params
 */
async function updateMeeting({ eventId, subject, start, end, attendees, body, location, userId }) {
  const target = userId ? `/users/${encodeURIComponent(userId)}` : '/me';
  const patch = {};
  if (subject !== undefined) patch.subject = subject;
  if (start !== undefined)   patch.start = { dateTime: start, timeZone: 'UTC' };
  if (end !== undefined)     patch.end = { dateTime: end, timeZone: 'UTC' };
  if (body !== undefined)    patch.body = { contentType: 'text', content: body };
  if (location !== undefined) patch.location = { displayName: location };
  if (attendees !== undefined) {
    patch.attendees = attendees.map(email => ({
      emailAddress: { address: email },
      type: 'required',
    }));
  }
  return graphRequest('PATCH', `${target}/events/${eventId}`, patch);
}

/**
 * Cancel a calendar event (notifies attendees).
 * @param {{ eventId: string, comment?: string }} params
 */
async function cancelMeeting({ eventId, comment = '', userId }) {
  const target = userId ? `/users/${encodeURIComponent(userId)}` : '/me';
  await graphRequest('POST', `${target}/events/${eventId}/cancel`, { comment });
  return { cancelled: true, eventId };
}

// ── Register tools ──────────────────────────────────────────────────────

registerTool('get_events', {
  top:    { type: 'number' },
  start:  { type: 'string' },
  end:    { type: 'string' },
  userId: { type: 'string' },
}, getEvents);

registerTool('get_event', {
  eventId: { type: 'string', required: true },
  userId:  { type: 'string' },
}, getEvent);

registerTool('find_free_time', {
  attendees:  { type: 'array', required: true },
  startRange: { type: 'string', required: true },
  endRange:   { type: 'string', required: true },
  duration:   { type: 'string', required: true },
}, findFreeTime);

registerTool('get_schedule', {
  users: { type: 'array', required: true },
  start: { type: 'string', required: true },
  end:   { type: 'string', required: true },
}, getSchedule);

registerTool('create_meeting', {
  subject:          { type: 'string', required: true },
  start:            { type: 'string', required: true },
  end:              { type: 'string', required: true },
  attendees:        { type: 'array' },
  body:             { type: 'string' },
  location:         { type: 'string' },
  isOnlineMeeting:  { type: 'boolean' },
  userId:           { type: 'string' },
}, createMeeting);

registerTool('update_meeting', {
  eventId:   { type: 'string', required: true },
  subject:   { type: 'string' },
  start:     { type: 'string' },
  end:       { type: 'string' },
  attendees: { type: 'array' },
  body:      { type: 'string' },
  location:  { type: 'string' },
  userId:    { type: 'string' },
}, updateMeeting);

registerTool('cancel_meeting', {
  eventId: { type: 'string', required: true },
  comment: { type: 'string' },
  userId:  { type: 'string' },
}, cancelMeeting);

module.exports = {
  getEvents,
  getEvent,
  findFreeTime,
  getSchedule,
  createMeeting,
  updateMeeting,
  cancelMeeting,
};
