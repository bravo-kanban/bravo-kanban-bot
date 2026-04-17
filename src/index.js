/**
 * index.js — Main entry point for bravo-kanban-bot
 *
 * Express server + Octokit App + webhook dispatcher
 */

import express from 'express';
import crypto from 'crypto';
import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';

import {
  PORT,
  APP_ID,
  PRIVATE_KEY,
  WEBHOOK_SECRET,
  GITHUB_ORG,
  GUARDIAN_REPOS,
  INSTALLATION_ID,
  PROJECT_ID,
  STATUS_FIELD_ID,
  AI_API_KEY,
  AI_BASE_URL,
  AI_MODEL,
  LINEAR_API_KEY,
  LINEAR_WEBHOOK_SECRET,
  LINEAR_ENABLED,
  setProjectConfig,
  setLinearTeams,
} from './config.js';
import { resolveProjectForIssue, resolveProjectFromEvent } from './project-resolver.js';
import { resolveLinearProject, resolveBacklogStateId } from './linear-resolver.js';
import { createGitHubAdapter, createLinearAdapter } from './platform.js';

import { runGuardian, isGuardianTrigger } from './guardian.js';
import { handleMove, parseMoveCommand } from './move-handler.js';
import { handleAI, isAICommand } from './ai-handler.js';
import { handleProtocol, isProtocolLabelAdded, isLinearProtocolIssue, handleLinearProtocol } from './protocol-handler.js';
import { handleReport, isReportCommand } from './reports.js';
import { fetchProjectConfig, getIssueComments, getIssue, getProjectItemForIssue, getStatusFieldOptions, updateProjectItemStatus } from './github-client.js';
import { linearGetTeams, linearGetIssue, linearGetIssueComments } from './linear-client.js';

// ─── App initialization ───────────────────────────────────────────────────────

if (!APP_ID || !PRIVATE_KEY || !WEBHOOK_SECRET) {
  console.error(
    '[boot] Missing required env vars: APP_ID, PRIVATE_KEY (or PRIVATE_KEY_PATH), WEBHOOK_SECRET',
  );
  process.exit(1);
}

const app = new App({
  appId: APP_ID,
  privateKey: PRIVATE_KEY,
  Octokit: Octokit,
  webhooks: {
    secret: WEBHOOK_SECRET,
  },
});

// ─── Webhook signature verification ──────────────────────────────────────────

function verifySignature(secret, payload, signature) {
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const digest = `sha256=${hmac.digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ─── Get authenticated Octokit for installation ───────────────────────────────

async function getOctokitForInstallation(installationId) {
  const octokit = await app.getInstallationOctokit(installationId);
  return octokit;
}

/**
 * Create an authenticated graphql function for a given installation.
 * Uses the built-in octokit.graphql which is already authenticated
 * via the installation token from @octokit/app.
 * @param {number} installationId
 * @returns {Promise<Function>}
 */
async function getGraphqlForInstallation(installationId) {
  const octokit = await app.getInstallationOctokit(installationId);
  return octokit.graphql;
}

// ─── Get real project status via GraphQL ─────────────────────────────────

/**
 * Fetch the real project status for an issue from GitHub Projects V2.
 * Uses getProjectItemForIssue which queries the project's field values.
 * Falls back to 'Backlog' if project item not found.
 * @param {Function} graphqlFn
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @returns {Promise<string>}
 */
async function getProjectContext(graphqlFn, owner, repo, issueNumber) {
  try {
    const resolved = await resolveProjectForIssue(graphqlFn, owner, repo, issueNumber);
    return {
      projectStatus: resolved?.currentStatus || 'Backlog',
      resolved,
    };
  } catch (err) {
    console.warn(`[webhook] Could not resolve project for #${issueNumber}: ${err.message}`);
    return { projectStatus: 'Backlog', resolved: null };
  }
}

// ─── Webhook event handlers ───────────────────────────────────────────────────

async function handleIssueOpened(payload, octokit, graphqlFn) {
  const { issue, repository } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const issueNumber = issue.number;

  const comments = await getIssueComments(octokit, owner, repo, issueNumber);
  const { projectStatus, resolved } = await getProjectContext(graphqlFn, owner, repo, issueNumber);
  const platform = createGitHubAdapter(octokit, graphqlFn, { owner, repo, issueNumber, resolved });

  await runGuardian({
    issue,
    projectStatus,
    comments,
    resolved,
    platform,
  });
}

async function handleIssueEdited(payload, octokit, graphqlFn) {
  const { issue, repository } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const issueNumber = issue.number;

  const comments = await getIssueComments(octokit, owner, repo, issueNumber);
  const { projectStatus, resolved } = await getProjectContext(graphqlFn, owner, repo, issueNumber);
  const platform = createGitHubAdapter(octokit, graphqlFn, { owner, repo, issueNumber, resolved });

  await runGuardian({
    issue,
    projectStatus,
    comments,
    resolved,
    platform,
  });
}

async function handleIssueCommentCreated(payload, octokit, graphqlFn) {
  const { comment, issue, repository } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const issueNumber = issue.number;
  const commentBody = comment.body || '';
  const commenterLogin = comment.user?.login || '';

  // Skip bot's own comments
  if (comment.user?.type === 'Bot') return;

  const { projectStatus, resolved } = await getProjectContext(graphqlFn, owner, repo, issueNumber);

  // Check for /report command first
  if (isReportCommand(commentBody)) {
    await handleReport(octokit, graphqlFn, {
      owner,
      repo,
      issueNumber,
      commentBody,
      callerLogin: commenterLogin,
    });
    return;
  }

  // Check for /move command
  const moveTarget = parseMoveCommand(commentBody);
  if (moveTarget) {
    await handleMove(octokit, graphqlFn, {
      owner,
      repo,
      issueNumber,
      issue,
      commentBody,
      commenterLogin,
      currentStatus: projectStatus,
      resolved,
    });
    return; // Don't run guardian after move — it'll run on next open/edit
  }

  // Check for /ai command
  if (isAICommand(commentBody)) {
    const platform = createGitHubAdapter(octokit, graphqlFn, { owner, repo, issueNumber, resolved });
    await handleAI({ issue, platform, commentBody });
    // Also run guardian in parallel
    const comments = await getIssueComments(octokit, owner, repo, issueNumber);
    await runGuardian({
      issue,
      projectStatus,
      comments,
      resolved,
      platform,
    });
    return;
  }

  // Check for Guardian trigger
  if (isGuardianTrigger(commentBody)) {
    const comments = await getIssueComments(octokit, owner, repo, issueNumber);
    const platform = createGitHubAdapter(octokit, graphqlFn, { owner, repo, issueNumber, resolved });
    await runGuardian({
      issue,
      projectStatus,
      comments,
      resolved,
      platform,
    });
  }
}

// ─── projects_v2_item handler ───────────────────────────────────────────────

/**
 * Handle projects_v2_item webhook events.
 * These fire when an issue is added to a project or its field (e.g. Status) changes.
 * We extract the linked issue and run Guardian on it.
 */
async function handleProjectItemEvent(payload, octokit, graphqlFn) {
  try {
    const contentNodeId = payload.projects_v2_item?.content_node_id;
    const contentType = payload.projects_v2_item?.content_type;
    const projectItemNodeId = payload.projects_v2_item?.node_id;

    // Only process Issue items (not DraftIssue or PullRequest)
    if (contentType !== 'Issue' || !contentNodeId) {
      console.log(`[webhook] projects_v2_item: content_type=${contentType}, skipping`);
      return;
    }

    // Single GraphQL query: fetch issue details + project item status
    const query = `
      query($issueNodeId: ID!, $itemNodeId: ID!) {
        issue: node(id: $issueNodeId) {
          ... on Issue {
            number
            title
            body
            state
            updatedAt
            labels(first: 20) { nodes { name } }
            assignees(first: 10) { nodes { login } }
            repository {
              name
              owner { login }
            }
          }
        }
        projectItem: node(id: $itemNodeId) {
          ... on ProjectV2Item {
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field {
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const result = await graphqlFn(query, {
      issueNodeId: contentNodeId,
      itemNodeId: projectItemNodeId,
    });

    const issueData = result?.issue;
    const projectItemData = result?.projectItem;

    if (!issueData || !issueData.repository) {
      console.warn('[webhook] projects_v2_item: could not fetch linked issue');
      return;
    }

    const owner = issueData.repository.owner.login;
    const repo = issueData.repository.name;
    const issueNumber = issueData.number;

    // Check if this repo is in our guardian list
    if (!GUARDIAN_REPOS.includes(repo)) {
      console.log(`[webhook] projects_v2_item: ${owner}/${repo}#${issueNumber} not in GUARDIAN_REPOS, skipping`);
      return;
    }

    // Extract real status from project item field values
    const fieldValues = projectItemData?.fieldValues?.nodes || [];
    const statusField = fieldValues.find(
      (fv) => fv?.field?.name?.toLowerCase().includes('status'),
    );
    let projectStatus = statusField?.name || null;

    // Auto-assign Backlog when item is added to project with no status
    if (!projectStatus && payload.action === 'created' && projectItemNodeId) {
      console.log(`[webhook] projects_v2_item.created: ${owner}/${repo}#${issueNumber} has no status, auto-assigning Backlog`);
      const eventProjectNodeId = payload.projects_v2_item?.project_node_id;
      const eventProject = resolveProjectFromEvent(eventProjectNodeId);
      const pId = eventProject?.projectId || PROJECT_ID;
      const sfId = eventProject?.statusFieldId || STATUS_FIELD_ID;
      try {
        const options = await getStatusFieldOptions(graphqlFn, pId, sfId);
        const backlogOption = options.find((o) => o.name.toLowerCase().includes('backlog'));
        if (backlogOption) {
          await updateProjectItemStatus(graphqlFn, pId, projectItemNodeId, sfId, backlogOption.id);
          console.log(`[webhook] Auto-assigned Backlog to ${owner}/${repo}#${issueNumber} in ${eventProject?.key || 'default'}`);
        }
      } catch (autoErr) {
        console.warn(`[webhook] Failed to auto-assign Backlog: ${autoErr.message}`);
      }
      projectStatus = 'Backlog';
    }

    if (!projectStatus) projectStatus = 'Backlog';

    console.log(`[webhook] projects_v2_item.${payload.action}: processing ${owner}/${repo}#${issueNumber} (status: ${projectStatus})`);

    // Skip Guardian re-run if we just auto-assigned Backlog (it will fire an 'edited' event)
    if (payload.action === 'created' && !statusField?.name) {
      // Guardian will run when the 'edited' event fires after status assignment
      console.log(`[webhook] Skipping Guardian on 'created' — will run on subsequent 'edited' event`);
      return;
    }

    // Debounce is now handled inside runGuardian itself (global for all entry points)

    // Build issue object compatible with Guardian
    const issue = {
      number: issueData.number,
      title: issueData.title,
      body: issueData.body || '',
      state: issueData.state,
      updated_at: issueData.updatedAt,
      labels: (issueData.labels?.nodes || []).map((l) => ({ name: l.name })),
      assignees: (issueData.assignees?.nodes || []).map((a) => ({ login: a.login })),
    };

    const comments = await getIssueComments(octokit, owner, repo, issueNumber);

    // Resolve project from the webhook event
    const eventProjectNodeId = payload.projects_v2_item?.project_node_id;
    const eventProject = resolveProjectFromEvent(eventProjectNodeId);
    const resolved = eventProject ? {
      key: eventProject.key,
      projectId: eventProject.projectId,
      statusFieldId: eventProject.statusFieldId,
      backlogOptionId: eventProject.backlogOptionId,
      itemId: projectItemNodeId,
      currentStatus: projectStatus,
    } : null;

    const platform = createGitHubAdapter(octokit, graphqlFn, { owner, repo, issueNumber, resolved });
    await runGuardian({
      issue,
      projectStatus,
      comments,
      resolved,
      platform,
    });
  } catch (err) {
    console.error(`[webhook] handleProjectItemEvent error: ${err.message}`, err.stack);
  }
}

// ─── Express setup ────────────────────────────────────────────────────────────

const server = express();

// Raw body parser for webhook signature verification (GitHub + Linear)
const rawBodyJsonParser = express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
});
server.use('/github-app', rawBodyJsonParser);
server.use('/linear-webhook', rawBodyJsonParser);

// Health check
server.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'bravo-kanban-bot',
    time: new Date().toISOString(),
  });
});

// Webhook endpoint
server.post('/github-app', async (req, res) => {
  // Verify signature
  const signature = req.headers['x-hub-signature-256'];
  const rawBody = req.rawBody;

  if (!verifySignature(WEBHOOK_SECRET, rawBody, signature)) {
    console.warn('[webhook] Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.headers['x-github-event'];
  const payload = req.body;
  const installationId = payload?.installation?.id;

  if (!installationId) {
    return res.status(400).json({ error: 'Missing installation ID' });
  }

  // Respond immediately (GitHub requires < 10s response)
  res.status(202).json({ accepted: true });

  // Process asynchronously
  setImmediate(async () => {
    try {
      const octokit = await getOctokitForInstallation(installationId);
      const graphqlFn = await getGraphqlForInstallation(installationId);

      console.log(`[webhook] Event: ${event}, action: ${payload.action}`);

      if (event === 'issues') {
        if (payload.action === 'labeled' && isProtocolLabelAdded(payload)) {
          // Protocol label added — parse protocol and create issues
          const { issue, repository } = payload;
          await handleProtocol(octokit, {
            owner: repository.owner.login,
            repo: repository.name,
            issueNumber: issue.number,
            issue,
            graphqlFn,
          });
        } else if (payload.action === 'opened' || payload.action === 'transferred') {
          await handleIssueOpened(payload, octokit, graphqlFn);
        } else if (payload.action === 'edited') {
          await handleIssueEdited(payload, octokit, graphqlFn);
        }
      } else if (event === 'issue_comment') {
        if (payload.action === 'created') {
          await handleIssueCommentCreated(payload, octokit, graphqlFn);
        }
      } else if (event === 'projects_v2_item') {
        // Handle project item events (created = issue added to project, edited = status changed)
        if (payload.action === 'created' || payload.action === 'edited') {
          await handleProjectItemEvent(payload, octokit, graphqlFn);
        } else {
          console.log(`[webhook] projects_v2_item.${payload.action} — skipped`);
        }
      } else if (event === 'ping') {
        console.log('[webhook] Ping received — app is connected');
      } else {
        console.log(`[webhook] Unhandled event: ${event}`);
      }
    } catch (err) {
      console.error(`[webhook] Processing error: ${err.message}`, err.stack);
    }
  });
});

// ─── Linear webhook signature verification ──────────────────────────────────

function verifyLinearSignature(secret, payload, signature) {
  if (!secret || !signature) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const digest = hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ─── Linear webhook event handlers ───────────────────────────────────────────

/**
 * Handle Linear issue create/update events.
 * Resolves Guardian profile from team + project, creates Linear adapter, runs Guardian.
 */
async function handleLinearIssueEvent(webhookPayload) {
  try {
    const { data: issueData, action } = webhookPayload;
    if (!issueData?.id) {
      console.warn('[linear-webhook] Issue event with no issue ID');
      return;
    }

    // Fetch full issue data from API (webhook data may be partial)
    const fullIssue = await linearGetIssue(issueData.id);
    if (!fullIssue) {
      console.warn(`[linear-webhook] Could not fetch issue ${issueData.id}`);
      return;
    }

    // Resolve Guardian profile
    const projectKey = resolveLinearProject(fullIssue);
    const teamId = fullIssue.team?.id;
    const stateName = fullIssue.state?.name || 'Backlog';
    const backlogStateId = teamId ? resolveBacklogStateId(teamId) : null;

    // Build issue object compatible with Guardian
    const issue = {
      title: fullIssue.title || '',
      body: fullIssue.description || '',
      state: fullIssue.state?.name || '',
      updated_at: fullIssue.updatedAt || new Date().toISOString(),
      dueDate: fullIssue.dueDate || null,
      labels: (fullIssue.labels?.nodes || []).map((l) => ({ name: l.name })),
      assignees: fullIssue.assignee
        ? [{ id: fullIssue.assignee.id, name: fullIssue.assignee.name, displayName: fullIssue.assignee.displayName }]
        : [],
    };

    // Get comments
    const comments = await linearGetIssueComments(issueData.id);

    // Create platform adapter
    const platform = createLinearAdapter({
      issueId: issueData.id,
      teamId,
      backlogStateId,
    });

    const resolved = { key: projectKey };

    console.log(`[linear-webhook] Issue ${action}: ${fullIssue.title} (project: ${projectKey || 'unknown'}, state: ${stateName})`);

    // Check if this is a protocol issue (has label "Протокол")
    const hasProtocolLabel = isLinearProtocolIssue(fullIssue);
    const alreadyProcessed = (fullIssue.labels?.nodes || []).some(
      (l) => (l.name || '').toLowerCase() === 'protocol: processed',
    );

    if (hasProtocolLabel && !alreadyProcessed) {
      console.log(`[linear-webhook] Protocol detected: ${fullIssue.title}`);
      await handleLinearProtocol({
        issueId: issueData.id,
        issue,
        teamId,
        projectId: fullIssue.project?.id || null,
      });
      return;
    }

    await runGuardian({
      issue,
      projectStatus: stateName,
      comments,
      resolved,
      platform,
    });
  } catch (err) {
    console.error(`[linear-webhook] handleLinearIssueEvent error: ${err.message}`, err.stack);
  }
}

/**
 * Handle Linear comment create events.
 * Checks for slash commands (/guardian, /ai, /report, /move) or triggers Guardian.
 */
async function handleLinearCommentEvent(webhookPayload) {
  try {
    const { data: commentData } = webhookPayload;
    const commentBody = commentData?.body || '';
    const issueId = commentData?.issueId || commentData?.issue?.id;

    if (!issueId) {
      console.warn('[linear-webhook] Comment event with no issue ID');
      return;
    }

    // Skip bot's own comments (actor check)
    // Linear doesn't have a "Bot" type, so we skip by checking if the actor
    // is the API key owner — for now, check if comment contains our marker
    if (commentBody.includes('<!-- guardian-check -->') || commentBody.includes('<!-- ai-analysis -->')) return;

    // Determine if we need to fetch issue data (for /ai or /guardian)
    const needsAI = isAICommand(commentBody);
    const needsGuardian = isGuardianTrigger(commentBody);

    if (!needsAI && !needsGuardian) return;

    // Fetch full issue — needed for both /ai and /guardian
    const fullIssue = await linearGetIssue(issueId);
    if (!fullIssue) return;

    const projectKey = resolveLinearProject(fullIssue);
    const teamId = fullIssue.team?.id;
    const stateName = fullIssue.state?.name || 'Backlog';
    const backlogStateId = teamId ? resolveBacklogStateId(teamId) : null;

    const issue = {
      title: fullIssue.title || '',
      body: fullIssue.description || '',
      state: fullIssue.state?.name || '',
      updated_at: fullIssue.updatedAt || new Date().toISOString(),
      dueDate: fullIssue.dueDate || null,
      labels: (fullIssue.labels?.nodes || []).map((l) => ({ name: l.name })),
      assignees: fullIssue.assignee
        ? [{ id: fullIssue.assignee.id, name: fullIssue.assignee.name, displayName: fullIssue.assignee.displayName }]
        : [],
    };

    const platform = createLinearAdapter({ issueId, teamId, backlogStateId });

    // Handle /ai command
    if (needsAI) {
      console.log(`[linear-webhook] /ai command on ${fullIssue.identifier}`);
      await handleAI({ issue, platform, commentBody });
    }

    // Handle Guardian trigger
    if (needsGuardian) {
      const comments = await linearGetIssueComments(issueId);
      await runGuardian({
        issue,
        projectStatus: stateName,
        comments,
        resolved: { key: projectKey },
        platform,
      });
    }
  } catch (err) {
    console.error(`[linear-webhook] handleLinearCommentEvent error: ${err.message}`, err.stack);
  }
}

// ─── Linear webhook endpoint ─────────────────────────────────────────────────

server.post('/linear-webhook', async (req, res) => {
  // 1. Verify signature
  const signature = req.headers['linear-signature'];
  if (!verifyLinearSignature(LINEAR_WEBHOOK_SECRET, req.rawBody, signature)) {
    console.warn('[linear-webhook] Invalid signature');
    return res.sendStatus(401);
  }

  // 2. Check timestamp freshness (reject if > 60s old)
  const webhookTimestamp = req.body?.webhookTimestamp;
  if (webhookTimestamp && Math.abs(Date.now() - webhookTimestamp) > 60_000) {
    console.warn('[linear-webhook] Stale timestamp');
    return res.sendStatus(401);
  }

  // Respond immediately
  res.sendStatus(200);

  // 3. Process async
  setImmediate(async () => {
    try {
      const { action, type } = req.body;
      console.log(`[linear-webhook] Event: type=${type}, action=${action}`);

      if (type === 'Issue' && (action === 'create' || action === 'update')) {
        await handleLinearIssueEvent(req.body);
      } else if (type === 'Comment' && action === 'create') {
        await handleLinearCommentEvent(req.body);
      } else {
        console.log(`[linear-webhook] Unhandled: type=${type}, action=${action}`);
      }
    } catch (err) {
      console.error(`[linear-webhook] Processing error: ${err.message}`, err.stack);
    }
  });
});

// 404 handler
server.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function bootstrap() {
  // Fetch PROJECT.json from primary repo and cache it
  try {
    const octokit = await app.getInstallationOctokit(Number(INSTALLATION_ID));
    const config = await fetchProjectConfig(octokit, GITHUB_ORG, 'sur-tasks');
    if (config) {
      setProjectConfig(config);
      console.log('[boot] PROJECT.json loaded from sur-tasks');
    } else {
      console.warn('[boot] PROJECT.json not found in sur-tasks — using defaults');
    }
  } catch (err) {
    console.warn(`[boot] Could not fetch PROJECT.json: ${err.message}`);
  }

  // Bootstrap Linear: fetch teams and workflow states
  if (LINEAR_API_KEY) {
    try {
      const teams = await linearGetTeams();
      setLinearTeams(teams);
      console.log(`[boot] Linear: ${Object.keys(teams).length} teams loaded (${Object.keys(teams).join(', ')})`);
    } catch (err) {
      console.warn(`[boot] Could not bootstrap Linear: ${err.message}`);
    }
  }

  server.listen(PORT, () => {
    console.log(`[boot] bravo-kanban-bot listening on port ${PORT}`);
    console.log(`[boot] Webhook endpoints: POST /github-app, POST /linear-webhook`);
    console.log(`[boot] Health check:      GET  /health`);
    console.log(`[boot] Org: ${GITHUB_ORG} | Repos: ${GUARDIAN_REPOS.join(', ')}`);
    if (AI_API_KEY) {
      console.log(`[boot] AI: ${AI_BASE_URL} | Model: ${AI_MODEL} | Key: ${AI_API_KEY.slice(0, 8)}…`);
    } else {
      console.error('[boot] ⚠️ AI_API_KEY is NOT set — protocol parsing and AI checks will not work!');
    }
    if (LINEAR_ENABLED) {
      console.log(`[boot] Linear: ENABLED (key: ${LINEAR_API_KEY.slice(0, 8)}…)`);
    } else {
      console.log('[boot] Linear: DISABLED (no LINEAR_API_KEY)');
    }
  });
}

bootstrap().catch((err) => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
