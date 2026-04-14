/**
 * index.js — Main entry point for bravo-kanban-bot
 *
 * Express server + Octokit App + webhook dispatcher
 */

import express from 'express';
import crypto from 'crypto';
import { App } from '@octokit/app';
import { graphql } from '@octokit/graphql';

import {
  PORT,
  APP_ID,
  PRIVATE_KEY,
  WEBHOOK_SECRET,
  GITHUB_ORG,
  GUARDIAN_REPOS,
  setProjectConfig,
} from './config.js';

import { runGuardian, isGuardianTrigger } from './guardian.js';
import { handleMove, parseMoveCommand } from './move-handler.js';
import { handleAI, isAICommand } from './ai-handler.js';
import { fetchProjectConfig, getIssueComments } from './github-client.js';

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
 * @param {number} installationId
 * @returns {Promise<Function>}
 */
async function getGraphqlForInstallation(installationId) {
  // Get installation token
  const { data: token } = await (
    await app.getInstallationOctokit(installationId)
  ).rest.apps.createInstallationAccessToken({ installation_id: installationId });

  return graphql.defaults({
    headers: {
      authorization: `token ${token.token}`,
    },
  });
}

// ─── Derive current project status from issue/payload ────────────────────────

/**
 * Try to extract the current project status from a webhook payload.
 * GitHub Projects V2 events don't always include status in issue webhooks,
 * so we fall back to labels.
 * @param {object} issue
 * @returns {string}
 */
function extractCurrentStatus(issue) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name || ''));
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (lower.includes('backlog')) return 'Backlog';
    if (lower.includes('to do') || lower.includes('todo')) return 'To Do';
    if (lower.includes('in progress')) return 'In Progress';
    if (lower.includes('review')) return 'Review';
    if (lower.includes('done')) return 'Done';
  }
  return 'Backlog';
}

// ─── Webhook event handlers ───────────────────────────────────────────────────

async function handleIssueOpened(payload, octokit, graphqlFn) {
  const { issue, repository, installation } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const issueNumber = issue.number;

  const comments = await getIssueComments(octokit, owner, repo, issueNumber);
  const currentStatus = extractCurrentStatus(issue);

  await runGuardian(octokit, {
    owner,
    repo,
    issueNumber,
    issue,
    projectStatus: currentStatus,
    comments,
  });
}

async function handleIssueEdited(payload, octokit, graphqlFn) {
  const { issue, repository } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const issueNumber = issue.number;

  const comments = await getIssueComments(octokit, owner, repo, issueNumber);
  const currentStatus = extractCurrentStatus(issue);

  await runGuardian(octokit, {
    owner,
    repo,
    issueNumber,
    issue,
    projectStatus: currentStatus,
    comments,
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

  const currentStatus = extractCurrentStatus(issue);

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
      currentStatus,
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
      projectStatus: currentStatus,
      comments,
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
      projectStatus: currentStatus,
      comments,
    });
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
        if (payload.action === 'opened') {
          await handleIssueOpened(payload, octokit, graphqlFn);
        } else if (payload.action === 'edited') {
          await handleIssueEdited(payload, octokit, graphqlFn);
        }
      } else if (event === 'issue_comment') {
        if (payload.action === 'created') {
          await handleIssueCommentCreated(payload, octokit, graphqlFn);
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
    // Use the app's JWT to get an installation list
    const installations = await app.octokit.rest.apps.listInstallations({ per_page: 10 });
    const installation = installations.data.find(
      (i) => i.account?.login === GITHUB_ORG,
    ) || installations.data[0];

    if (installation) {
      const octokit = await app.getInstallationOctokit(installation.id);
      const config = await fetchProjectConfig(octokit, GITHUB_ORG, 'sur-bravo');
      if (config) {
        setProjectConfig(config);
        console.log('[boot] PROJECT.json loaded from sur-bravo');
      } else {
        console.warn('[boot] PROJECT.json not found in sur-bravo — using defaults');
      }
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
