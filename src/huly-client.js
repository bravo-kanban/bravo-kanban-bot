/**
 * huly-client.js — Huly Platform API client wrapper
 *
 * Talks to a Huly workspace via the official @hcengineering/api-client SDK.
 * Provides a focused surface used by the bot: list issues by status, post
 * comments, change issue status, fetch comments.
 *
 * Hard-coded class IDs (e.g. 'tracker:class:Issue') come from the Huly plugin
 * id convention `${pluginId}:${kind}:${name}` — we avoid pulling the
 * @hcengineering/tracker package because it requires GitHub Packages auth.
 */

import {
  HULY_URL,
  HULY_WORKSPACE,
  HULY_EMAIL,
  HULY_PASSWORD,
  HULY_TOKEN,
  HULY_ENABLED,
  HULY_PROJECT_IDENTIFIERS,
} from './config.js';

// ─── Hard-coded Huly class / plugin IDs ──────────────────────────────────────
// Huly generates these strings from its plugin definitions; they are stable
// across versions for the public tracker / chunter plugins.
export const HULY_CLASS = {
  Project: 'tracker:class:Project',
  Issue: 'tracker:class:Issue',
  IssueStatus: 'tracker:class:IssueStatus',
  ChatMessage: 'chunter:class:ChatMessage',
};

// ─── Lazy import of api-client + text-markdown ───────────────────────────────
// We import dynamically so the rest of the app can boot even if Huly is not
// configured / the optional deps are missing.

let _apiClientPromise = null;
async function loadApiClient() {
  if (!_apiClientPromise) {
    _apiClientPromise = import('@hcengineering/api-client').then((mod) => mod.default || mod);
  }
  return _apiClientPromise;
}

let _textMarkdownPromise = null;
async function loadTextMarkdown() {
  if (!_textMarkdownPromise) {
    _textMarkdownPromise = import('@hcengineering/text-markdown')
      .then((mod) => mod.default || mod)
      .catch(() => null);
  }
  return _textMarkdownPromise;
}

// ─── Markdown → Markup (Prosemirror JSON) ────────────────────────────────────

/**
 * Convert a markdown string to a Markup (Prosemirror JSON) string.
 * Falls back to a minimal single-paragraph Markup doc if text-markdown is
 * unavailable.
 * @param {string} md
 * @returns {Promise<string>}
 */
export async function markdownToMarkupString(md) {
  const text = String(md ?? '');
  const lib = await loadTextMarkdown();
  if (lib && typeof lib.markdownToMarkup === 'function') {
    try {
      const node = lib.markdownToMarkup(text);
      return JSON.stringify(node);
    } catch (err) {
      console.warn(`[huly] markdownToMarkup failed: ${err.message}, using fallback`);
    }
  }
  // Fallback: split paragraphs on blank lines, plain-text only.
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const content = (paragraphs.length ? paragraphs : [text]).map((p) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: p }],
  }));
  return JSON.stringify({ type: 'doc', content });
}

// ─── Singleton client ────────────────────────────────────────────────────────

let _client = null;
let _connectPromise = null;

/**
 * Get the connected Huly client. Reuses one persistent WebSocket connection.
 * Returns null if Huly is not configured.
 */
export async function getHulyClient() {
  if (!HULY_ENABLED) return null;
  if (_client) return _client;
  if (_connectPromise) return _connectPromise;

  _connectPromise = (async () => {
    const { connect, NodeWebSocketFactory } = await loadApiClient();
    const opts = {
      workspace: HULY_WORKSPACE,
      socketFactory: NodeWebSocketFactory,
      connectionTimeout: 30000,
    };
    if (HULY_TOKEN) {
      opts.token = HULY_TOKEN;
    } else {
      opts.email = HULY_EMAIL;
      opts.password = HULY_PASSWORD;
    }
    console.log(`[huly] Connecting to ${HULY_URL} (workspace: ${HULY_WORKSPACE}, auth: ${HULY_TOKEN ? 'token' : 'email/password'})`);
    const client = await connect(HULY_URL, opts);
    _client = client;
    _connectPromise = null;
    console.log('[huly] Connected');
    return client;
  })().catch((err) => {
    _connectPromise = null;
    throw err;
  });

  return _connectPromise;
}

/**
 * Close the persistent client (used in tests / graceful shutdown).
 */
export async function closeHulyClient() {
  if (_client) {
    try { await _client.close(); } catch { /* ignore */ }
    _client = null;
  }
}

// ─── Projects ────────────────────────────────────────────────────────────────

/**
 * Find all tracker projects accessible to the service account.
 * If HULY_PROJECT_IDENTIFIERS is set, filters to those identifiers.
 * @returns {Promise<Array<{_id, identifier, name, description}>>}
 */
export async function listProjects() {
  const client = await getHulyClient();
  if (!client) return [];
  const all = await client.findAll(HULY_CLASS.Project, {});
  if (HULY_PROJECT_IDENTIFIERS.length > 0) {
    return all.filter((p) => HULY_PROJECT_IDENTIFIERS.includes(p.identifier));
  }
  return all;
}

// ─── Statuses ────────────────────────────────────────────────────────────────

/**
 * Fetch all IssueStatus docs for a given project's task type.
 * Statuses in Huly belong to the project's TaskType, but findAll on
 * IssueStatus returns all of them; we filter by the project-type relation
 * via project.type.
 * @param {object} project — full project doc
 * @returns {Promise<Array<{_id, name, category}>>}
 */
export async function listProjectStatuses(project) {
  const client = await getHulyClient();
  if (!client) return [];
  // IssueStatus has `space: project._id` for project-specific custom statuses;
  // for shared/default statuses they live under the project type's space.
  // Easiest: fetch all IssueStatus and the caller filters by project's type.
  const all = await client.findAll(HULY_CLASS.IssueStatus, {});
  return all;
}

/**
 * Resolve a status _id by case-insensitive name within a project.
 * Looks among statuses whose ofAttribute belongs to the project's type chain.
 * @param {object} project
 * @param {string} name
 * @returns {Promise<string|null>}
 */
export async function resolveStatusIdByName(project, name) {
  const client = await getHulyClient();
  if (!client) return null;
  const target = String(name).trim().toLowerCase();

  // Strategy: load the project type; iterate its statuses (by id list) and
  // fetch their IssueStatus docs to find matching name.
  const projectType = project?.type;
  if (!projectType) return null;

  // Load task types for this project type to get the status list.
  // ProjectType.statuses is an array of Ref<Status>. We can query them.
  // But we don't always have $lookup; fetch all IssueStatus for the project's
  // task type space and filter by name.
  const candidates = await client.findAll(HULY_CLASS.IssueStatus, {});
  const match = candidates.find((s) => String(s.name || '').trim().toLowerCase() === target);
  return match?._id || null;
}

// ─── Issues ──────────────────────────────────────────────────────────────────

/**
 * Find issues in a project that have the given status name.
 * @param {object} project
 * @param {string} statusName
 * @returns {Promise<Array<object>>}
 */
export async function findIssuesByStatusName(project, statusName) {
  const client = await getHulyClient();
  if (!client) return [];
  const statusId = await resolveStatusIdByName(project, statusName);
  if (!statusId) return [];
  return client.findAll(HULY_CLASS.Issue, {
    space: project._id,
    status: statusId,
  });
}

/**
 * Move an issue to a status by name.
 * @param {object} issue — Issue doc with _id and space
 * @param {object} project
 * @param {string} statusName
 * @returns {Promise<boolean>}
 */
export async function moveIssueToStatus(issue, project, statusName) {
  const client = await getHulyClient();
  if (!client) return false;
  const statusId = await resolveStatusIdByName(project, statusName);
  if (!statusId) {
    console.warn(`[huly] moveIssueToStatus: status "${statusName}" not found in project ${project.identifier}`);
    return false;
  }
  await client.updateDoc(HULY_CLASS.Issue, issue.space, issue._id, { status: statusId });
  return true;
}

/**
 * Fetch the markdown text of an issue's description.
 * @param {object} issue
 * @returns {Promise<string>}
 */
export async function getIssueDescriptionMarkdown(issue) {
  const client = await getHulyClient();
  if (!client || !issue?.description) return '';
  try {
    return await client.fetchMarkup(HULY_CLASS.Issue, issue._id, 'description', issue.description, 'markdown');
  } catch (err) {
    console.warn(`[huly] fetchMarkup failed for ${issue.identifier}: ${err.message}`);
    return '';
  }
}

// ─── Comments ────────────────────────────────────────────────────────────────

/**
 * Post a markdown comment on an issue.
 * @param {object} issue — must have _id and space (project ref)
 * @param {string} markdownBody
 * @returns {Promise<{id: string}|null>}
 */
export async function postIssueComment(issue, markdownBody) {
  const client = await getHulyClient();
  if (!client) return null;
  const message = await markdownToMarkupString(markdownBody);
  const id = await client.addCollection(
    HULY_CLASS.ChatMessage,
    issue.space,
    issue._id,
    HULY_CLASS.Issue,
    'comments',
    { message },
  );
  return { id };
}

/**
 * Fetch chat-message comments attached to an issue, oldest first.
 * @param {object} issue
 * @returns {Promise<Array<{_id, message, modifiedOn, modifiedBy, createdBy, createdOn}>>}
 */
export async function listIssueComments(issue) {
  const client = await getHulyClient();
  if (!client) return [];
  const comments = await client.findAll(
    HULY_CLASS.ChatMessage,
    { attachedTo: issue._id, attachedToClass: HULY_CLASS.Issue },
    { sort: { createdOn: 1 } },
  );
  return comments;
}

/**
 * Extract plain text from a Markup (Prosemirror JSON) string.
 * @param {string} markup
 * @returns {string}
 */
export function markupToPlainText(markup) {
  if (!markup) return '';
  let json;
  try {
    json = typeof markup === 'string' ? JSON.parse(markup) : markup;
  } catch {
    return String(markup);
  }
  const out = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'text' && typeof node.text === 'string') {
      out.push(node.text);
      return;
    }
    if (Array.isArray(node.content)) {
      for (const c of node.content) walk(c);
      // Add a newline after block-level nodes
      if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'list_item') {
        out.push('\n');
      }
    }
  }
  walk(json);
  return out.join('').trim();
}
