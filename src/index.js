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
  setProjectConfig,
} from './config.js';

import { runGuardian, isGuardianTrigger } from './guardian.js';
import { handleMove, parseMoveCommand } from './move-handler.js';
import { handleAI, isAICommand } from './ai-handler.js';
import { handleProtocol, isProtocolLabelAdded } from './protocol-handler.js';
import { fetchProjectConfig, getIssueComments, getIssue, getProjectItemForIssue } from './github-client.js';

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
async function getProjectStatus(graphqlFn, owner, repo, issueNumber) {
  try {
    const { currentStatus } = await getProjectItemForIssue(graphqlFn, PROJECT_ID, owner, repo, issueNumber);
    return currentStatus || 'Backlog';
  } catch (err) {
    console.warn(`[webhook] Could not fetch project status for #${issueNumber}: ${err.message}`);
    return 'Backlog';
  }
}

// ─── Webhook event handlers ───────────────────────────────────────────────────

async function handleIssueOpened(payload, octokit, graphqlFn) {
  const { issue, repository } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const issueNumber = issue.number;

  const comments = await getIssueComments(octokit, owner, repo, issueNumber);
  const projectStatus = await getProjectStatus(graphqlFn, owner, repo, issueNumber);

  await runGuardian(octokit, {
    owner,
    repo,
    issueNumber,
    issue,
    projectStatus,
    comments,
    graphqlFn,
  });
}

async function handleIssueEdited(payload, octokit, graphqlFn) {
  const { issue, repository } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const issueNumber = issue.number;

  const comments = await getIssueComments(octokit, owner, repo, issueNumber);
  const projectStatus = await getProjectStatus(graphqlFn, owner, repo, issueNumber);

  await runGuardian(octokit, {
    owner,
    repo,
    issueNumber,
    issue,
    projectStatus,
    comments,
    graphqlFn,
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

  const projectStatus = await getProjectStatus(graphqlFn, owner, repo, issueNumber);

  // Check for /move command first
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
    });
    return; // Don't run guardian after move — it'll run on next open/edit
  }

  // Check for /ai command
  if (isAICommand(commentBody)) {
    await handleAI(octokit, { owner, repo, issueNumber, issue });
    // Also run guardian in parallel
    const comments = await getIssueComments(octokit, owner, repo, issueNumber);
    await runGuardian(octokit, {
      owner,
      repo,
      issueNumber,
      issue,
      projectStatus,
      comments,
      graphqlFn,
    });
    return;
  }

  // Check for Guardian trigger
  if (isGuardianTrigger(commentBody)) {
    const comments = await getIssueComments(octokit, owner, repo, issueNumber);
    await runGuardian(octokit, {
      owner,
      repo,
      issueNumber,
      issue,
      projectStatus,
      comments,
      graphqlFn,
    });
  }
}

// ─── Debounce for project item events ────────────────────────────────────────

// Prevents duplicate Guardian runs when multiple project events fire in quick succession
// (e.g. Guardian moves card to Backlog → GitHub fires projects_v2_item.edited → loop)
const recentGuardianRuns = new Map(); // key: "owner/repo#number" → timestamp
const DEBOUNCE_MS = 15_000; // 15 seconds

function shouldSkipDebounce(owner, repo, issueNumber) {
  const key = `${owner}/${repo}#${issueNumber}`;
  const lastRun = recentGuardianRuns.get(key);
  const now = Date.now();
  if (lastRun && now - lastRun < DEBOUNCE_MS) {
    console.log(`[webhook] Debounce: skipping Guardian for ${key} (ran ${now - lastRun}ms ago)`);
    return true;
  }
  recentGuardianRuns.set(key, now);
  // Cleanup old entries every 100 runs
  if (recentGuardianRuns.size > 100) {
    for (const [k, v] of recentGuardianRuns) {
      if (now - v > 60_000) recentGuardianRuns.delete(k);
    }
  }
  return false;
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
    const projectStatus = statusField?.name || 'Backlog';

    console.log(`[webhook] projects_v2_item.${payload.action}: processing ${owner}/${repo}#${issueNumber} (status: ${projectStatus})`);

    // Debounce: skip if Guardian just ran on this issue (prevents loops)
    if (shouldSkipDebounce(owner, repo, issueNumber)) {
      return;
    }

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

    await runGuardian(octokit, {
      owner,
      repo,
      issueNumber,
      issue,
      projectStatus,
      comments,
      graphqlFn,
    });
  } catch (err) {
    console.error(`[webhook] handleProjectItemEvent error: ${err.message}`, err.stack);
  }
}

// ─── Express setup ────────────────────────────────────────────────────────────

const server = express();

// Raw body parser for webhook signature verification
server.use(
  '/github-app',
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

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

  server.listen(PORT, () => {
    console.log(`[boot] bravo-kanban-bot listening on port ${PORT}`);
    console.log(`[boot] Webhook endpoint: POST /github-app`);
    console.log(`[boot] Health check:     GET  /health`);
    console.log(`[boot] Org: ${GITHUB_ORG} | Repos: ${GUARDIAN_REPOS.join(', ')}`);
  });
}

bootstrap().catch((err) => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
