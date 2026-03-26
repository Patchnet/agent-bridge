'use strict';

/**
 * tasks.js — Task bridge tools (Microsoft To Do).
 *
 * Discrete, validated operations for task management via Microsoft Graph.
 */

const { graphRequest } = require('./graph');
const { registerTool } = require('./tools');

// ── Tool implementations ────────────────────────────────────────────────

/**
 * List all To Do task lists.
 */
async function listTaskLists() {
  const data = await graphRequest('GET', '/me/todo/lists?$select=id,displayName,isOwner');
  return data.value || [];
}

/**
 * Get tasks from a specific list.
 * @param {{ listId: string, top?: number }} params
 */
async function getTasks({ listId, top = 25 }) {
  const data = await graphRequest('GET',
    `/me/todo/lists/${listId}/tasks?$top=${top}&$orderby=createdDateTime desc&$select=id,title,status,importance,dueDateTime,body,createdDateTime`
  );
  return data.value || [];
}

/**
 * Create a task in a To Do list.
 * @param {{ listId: string, title: string, dueDate?: string, body?: string, importance?: string }} params
 */
async function createTask({ listId, title, dueDate, body, importance }) {
  const task = { title };
  if (dueDate) {
    task.dueDateTime = { dateTime: dueDate, timeZone: 'UTC' };
  }
  if (body) {
    task.body = { contentType: 'text', content: body };
  }
  if (importance) {
    task.importance = importance;
  }
  return graphRequest('POST', `/me/todo/lists/${listId}/tasks`, task);
}

/**
 * Update an existing task.
 * @param {{ listId: string, taskId: string, title?: string, status?: string, dueDate?: string }} params
 */
async function updateTask({ listId, taskId, title, status, dueDate }) {
  const patch = {};
  if (title !== undefined) patch.title = title;
  if (status !== undefined) patch.status = status;
  if (dueDate !== undefined) {
    patch.dueDateTime = { dateTime: dueDate, timeZone: 'UTC' };
  }
  return graphRequest('PATCH', `/me/todo/lists/${listId}/tasks/${taskId}`, patch);
}

// ── Register tools ──────────────────────────────────────────────────────

registerTool('list_task_lists', {}, listTaskLists);

registerTool('get_tasks', {
  listId: { type: 'string', required: true },
  top:    { type: 'number' },
}, getTasks);

registerTool('create_task', {
  listId:     { type: 'string', required: true },
  title:      { type: 'string', required: true },
  dueDate:    { type: 'string' },
  body:       { type: 'string' },
  importance: { type: 'string', enum: ['low', 'normal', 'high'] },
}, createTask);

registerTool('update_task', {
  listId: { type: 'string', required: true },
  taskId: { type: 'string', required: true },
  title:  { type: 'string' },
  status: { type: 'string', enum: ['notStarted', 'inProgress', 'completed'] },
  dueDate: { type: 'string' },
}, updateTask);

module.exports = {
  listTaskLists,
  getTasks,
  createTask,
  updateTask,
};
