/**
 * project-resolver.js — Determine which project(s) an issue belongs to.
 *
 * Queries all known projects from PROJECTS config and returns the matching
 * projectId + statusFieldId for a given issue.
 */

import { PROJECTS } from './config.js';

/**
 * Find which project contains the given issue.
 * Returns the first matching project entry with { key, projectId, statusFieldId, itemId, currentStatus }.
 * Falls back to parent project (e.g. СУР) if issue is not in any sub-project.
 *
 * @param {Function} graphqlFn
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @returns {Promise<{key: string, projectId: string, statusFieldId: string, itemId: string|null, currentStatus: string|null}|null>}
 */
export async function resolveProjectForIssue(graphqlFn, owner, repo, issueNumber) {
  // Get all projects that include this repo
  const candidates = Object.entries(PROJECTS)
    .filter(([, cfg]) => cfg.repos.includes(repo))
    // Check sub-projects first (those with `parent`), then parent projects
    .sort((a, b) => {
      const aHasParent = a[1].parent ? 0 : 1;
      const bHasParent = b[1].parent ? 0 : 1;
      return aHasParent - bHasParent;
    });

  if (candidates.length === 0) return null;

  // Query all candidate projects in parallel
  const results = await Promise.allSettled(
    candidates.map(async ([key, cfg]) => {
      const result = await queryProjectItem(graphqlFn, cfg.id, owner, repo, issueNumber);
      return { key, cfg, ...result };
    }),
  );

  // Find the first project that contains this issue (prefer sub-projects)
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.itemId) {
      const { key, cfg, itemId, currentStatus } = r.value;
      return {
        key,
        projectId: cfg.id,
        statusFieldId: cfg.statusFieldId,
        backlogOptionId: cfg.backlogOptionId || null,
        itemId,
        currentStatus,
      };
    }
  }

  // Not found in any project — return first candidate for fallback (e.g. to add to Backlog)
  const fallback = candidates[0];
  return {
    key: fallback[0],
    projectId: fallback[1].id,
    statusFieldId: fallback[1].statusFieldId,
    backlogOptionId: fallback[1].backlogOptionId || null,
    itemId: null,
    currentStatus: null,
  };
}

/**
 * Resolve project from a projects_v2_item webhook event.
 * Uses the project_node_id from the payload to match directly.
 *
 * @param {string} projectNodeId — from payload.projects_v2_item.project_node_id
 * @returns {{key: string, projectId: string, statusFieldId: string, backlogOptionId: string|null}|null}
 */
export function resolveProjectFromEvent(projectNodeId) {
  for (const [key, cfg] of Object.entries(PROJECTS)) {
    if (cfg.id === projectNodeId) {
      return {
        key,
        projectId: cfg.id,
        statusFieldId: cfg.statusFieldId,
        backlogOptionId: cfg.backlogOptionId || null,
      };
    }
  }
  return null;
}

// ─── GraphQL query ───────────────────────────────────────────────────────────

async function queryProjectItem(graphqlFn, projectId, owner, repo, issueNumber) {
  try {
    const query = `
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100) {
              nodes {
                id
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2SingleSelectField { name } }
                    }
                  }
                }
                content {
                  ... on Issue {
                    number
                    repository { name owner { login } }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const result = await graphqlFn(query, { projectId });
    const items = result?.node?.items?.nodes || [];

    for (const item of items) {
      const c = item.content;
      if (
        c &&
        c.number === issueNumber &&
        c.repository?.name === repo &&
        c.repository?.owner?.login === owner
      ) {
        const fieldValues = item.fieldValues?.nodes || [];
        const statusField = fieldValues.find(
          (fv) => fv?.field?.name?.toLowerCase() === 'status',
        );
        return {
          itemId: item.id,
          currentStatus: statusField?.name || null,
        };
      }
    }

    return { itemId: null, currentStatus: null };
  } catch (err) {
    console.warn(`[project-resolver] Error querying project ${projectId}: ${err.message}`);
    return { itemId: null, currentStatus: null };
  }
}
