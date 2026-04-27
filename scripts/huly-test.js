#!/usr/bin/env node
/**
 * scripts/huly-test.js — Huly connection diagnostic
 *
 * Usage:
 *   npm run huly:test
 *
 * Reads HULY_URL / HULY_WORKSPACE / HULY_EMAIL / HULY_PASSWORD (or HULY_TOKEN)
 * from .env, connects, and prints:
 *   - account info
 *   - all accessible projects (filtered by HULY_PROJECT_IDENTIFIERS if set)
 *   - whether "AI - to do" and "AI - done" statuses exist per project
 *   - count of issues currently in "AI - to do"
 */

import {
  HULY_ENABLED,
  HULY_URL,
  HULY_WORKSPACE,
  HULY_STATUS_TODO,
  HULY_STATUS_DONE,
  HULY_PROJECT_IDENTIFIERS,
} from '../src/config.js';
import {
  getHulyClient,
  closeHulyClient,
  listProjects,
  resolveStatusIdByName,
  findIssuesByStatusName,
} from '../src/huly-client.js';

async function main() {
  console.log('── Huly connection test ──────────────────────────────────────');
  console.log(`URL:        ${HULY_URL || '(not set)'}`);
  console.log(`Workspace:  ${HULY_WORKSPACE || '(not set)'}`);
  console.log(`Status TODO: "${HULY_STATUS_TODO}"`);
  console.log(`Status DONE: "${HULY_STATUS_DONE}"`);
  console.log(
    `Project filter: ${
      HULY_PROJECT_IDENTIFIERS.length ? HULY_PROJECT_IDENTIFIERS.join(', ') : '(none — all accessible projects)'
    }`,
  );
  console.log('');

  if (!HULY_ENABLED) {
    console.error(
      'ERROR: Huly is not configured. Set HULY_URL, HULY_WORKSPACE, and either HULY_TOKEN or HULY_EMAIL+HULY_PASSWORD in .env.',
    );
    process.exit(2);
  }

  const client = await getHulyClient();
  if (!client) {
    console.error('ERROR: getHulyClient returned null.');
    process.exit(2);
  }

  try {
    const account = await client.getAccount();
    console.log(`Connected as account: ${account?.uuid || '(unknown)'}`);
    console.log('');
  } catch (err) {
    console.warn(`getAccount failed: ${err.message}`);
  }

  let projects;
  try {
    projects = await listProjects();
  } catch (err) {
    console.error(`listProjects failed: ${err.message}`);
    await closeHulyClient();
    process.exit(3);
  }

  if (!projects.length) {
    console.warn(
      'No projects visible to the service account. ' +
        'Check that the user has access in Huly, or remove HULY_PROJECT_IDENTIFIERS to widen the scope.',
    );
    await closeHulyClient();
    process.exit(0);
  }

  console.log(`Visible projects: ${projects.length}`);
  let okCount = 0;
  for (const project of projects) {
    const todoId = await resolveStatusIdByName(project, HULY_STATUS_TODO);
    const doneId = await resolveStatusIdByName(project, HULY_STATUS_DONE);
    let todoCount = 0;
    if (todoId) {
      try {
        const issues = await findIssuesByStatusName(project, HULY_STATUS_TODO);
        todoCount = issues.length;
      } catch (err) {
        console.warn(`  ⚠ ${project.identifier}: count failed: ${err.message}`);
      }
    }
    const ok = todoId && doneId;
    if (ok) okCount += 1;
    console.log(
      `  ${ok ? '✓' : '⚠'} ${project.identifier.padEnd(10)} ` +
        `name="${project.name || ''}" ` +
        `${HULY_STATUS_TODO}=${todoId ? 'OK' : 'MISSING'} ` +
        `${HULY_STATUS_DONE}=${doneId ? 'OK' : 'MISSING'} ` +
        `pending=${todoCount}`,
    );
  }

  console.log('');
  console.log(
    `Result: ${okCount}/${projects.length} project(s) have both AI statuses configured.`,
  );

  await closeHulyClient();
  process.exit(okCount === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  closeHulyClient().finally(() => process.exit(10));
});
