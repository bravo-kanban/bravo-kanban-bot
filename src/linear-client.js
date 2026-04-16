/**
 * linear-client.js — Linear GraphQL API client
 *
 * Uses native fetch (Node 20+). All functions read LINEAR_API_KEY from config.
 */

import { LINEAR_API_KEY } from './config.js';

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

// ─── Base GraphQL caller ──────────────────────────────────────────────────────

/**
 * Execute a GraphQL query/mutation against the Linear API.
 * @param {string} query — GraphQL query or mutation string
 * @param {object} [variables] — query variables
 * @returns {Promise<object>} — the `data` field from the response
 * @throws on network or GraphQL errors
 */
export async function linearGraphQL(query, variables = {}) {
  const res = await fetch(LINEAR_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear API HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();

  if (json.errors?.length) {
    const messages = json.errors.map((e) => e.message).join('; ');
    throw new Error(`Linear GraphQL error: ${messages}`);
  }

  return json.data;
}

// ─── Comments ─────────────────────────────────────────────────────────────────

/**
 * Create a comment on a Linear issue.
 * @param {string} issueId — Linear issue UUID
 * @param {string} body — Markdown comment body
 * @returns {Promise<{id: string}|null>}
 */
export async function linearPostComment(issueId, body) {
  try {
    const data = await linearGraphQL(
      `mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id }
        }
      }`,
      { issueId, body },
    );
    const result = data?.commentCreate;
    if (!result?.success) {
      console.error('[linear] createComment: success=false');
      return null;
    }
    console.log(`[linear] Posted comment ${result.comment.id} on issue ${issueId}`);
    return result.comment;
  } catch (err) {
    console.error(`[linear] postComment error: ${err.message}`);
    return null;
  }
}

/**
 * Update an existing Linear comment.
 * @param {string} commentId — Linear comment UUID
 * @param {string} body — new Markdown body
 * @returns {Promise<{id: string}|null>}
 */
export async function linearUpdateComment(commentId, body) {
  try {
    const data = await linearGraphQL(
      `mutation($commentId: String!, $body: String!) {
        commentUpdate(id: $commentId, input: { body: $body }) {
          success
          comment { id }
        }
      }`,
      { commentId, body },
    );
    const result = data?.commentUpdate;
    if (!result?.success) {
      console.error('[linear] updateComment: success=false');
      return null;
    }
    console.log(`[linear] Updated comment ${commentId}`);
    return result.comment;
  } catch (err) {
    console.error(`[linear] updateComment error: ${err.message}`);
    return null;
  }
}

// ─── Issues ───────────────────────────────────────────────────────────────────

/**
 * Get a Linear issue with key fields.
 * @param {string} issueId — Linear issue UUID
 * @returns {Promise<object|null>}
 */
export async function linearGetIssue(issueId) {
  try {
    const data = await linearGraphQL(
      `query($issueId: String!) {
        issue(id: $issueId) {
          id
          identifier
          title
          description
          state { id name type }
          assignee { id name displayName }
          labels { nodes { id name } }
          team { id key name }
          project { id name }
          dueDate
          updatedAt
          createdAt
        }
      }`,
      { issueId },
    );
    return data?.issue || null;
  } catch (err) {
    console.error(`[linear] getIssue error: ${err.message}`);
    return null;
  }
}

/**
 * Get all comments on a Linear issue.
 * @param {string} issueId — Linear issue UUID
 * @returns {Promise<Array<{id: string, body: string, user: object, createdAt: string}>>}
 */
export async function linearGetIssueComments(issueId) {
  try {
    const data = await linearGraphQL(
      `query($issueId: String!) {
        issue(id: $issueId) {
          comments {
            nodes {
              id
              body
              user { id name }
              createdAt
              updatedAt
            }
          }
        }
      }`,
      { issueId },
    );
    // Normalize: Guardian expects `created_at` (GitHub format)
    const nodes = data?.issue?.comments?.nodes || [];
    return nodes.map((c) => ({
      ...c,
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    }));
  } catch (err) {
    console.error(`[linear] getIssueComments error: ${err.message}`);
    return [];
  }
}

// ─── Issue creation ──────────────────────────────────────────────────

/**
 * Create a new issue in Linear.
 * @param {object} params
 * @param {string} params.teamId — team UUID
 * @param {string} params.title
 * @param {string} [params.description] — markdown body
 * @param {string} [params.assigneeId]
 * @param {string} [params.projectId]
 * @param {string} [params.parentId] — parent issue (for sub-issues)
 * @param {string[]} [params.labelIds]
 * @param {string} [params.stateId] — initial workflow state
 * @param {string} [params.dueDate] — YYYY-MM-DD
 * @returns {Promise<{id: string, identifier: string, url: string, title: string}|null>}
 */
export async function linearCreateIssue({ teamId, title, description, assigneeId, projectId, parentId, labelIds, stateId, dueDate }) {
  try {
    const input = { teamId, title };
    if (description) input.description = description;
    if (assigneeId) input.assigneeId = assigneeId;
    if (projectId) input.projectId = projectId;
    if (parentId) input.parentId = parentId;
    if (labelIds?.length) input.labelIds = labelIds;
    if (stateId) input.stateId = stateId;
    if (dueDate) input.dueDate = dueDate;

    const data = await linearGraphQL(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            url
            title
          }
        }
      }`,
      { input },
    );
    const result = data?.issueCreate;
    if (!result?.success) {
      console.error('[linear] issueCreate: success=false');
      return null;
    }
    console.log(`[linear] Created issue ${result.issue.identifier}: ${result.issue.title}`);
    return result.issue;
  } catch (err) {
    console.error(`[linear] createIssue error: ${err.message}`);
    return null;
  }
}

/**
 * Add a label to a Linear issue.
 * @param {string} issueId
 * @param {string[]} labelIds
 * @returns {Promise<boolean>}
 */
export async function linearAddLabelsToIssue(issueId, labelIds) {
  try {
    // We need to get existing labels first, then merge
    const issue = await linearGetIssue(issueId);
    const existingIds = (issue?.labels?.nodes || []).map((l) => l.id);
    const allIds = [...new Set([...existingIds, ...labelIds])];

    const data = await linearGraphQL(
      `mutation($issueId: String!, $labelIds: [String!]!) {
        issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
          success
        }
      }`,
      { issueId, labelIds: allIds },
    );
    return data?.issueUpdate?.success || false;
  } catch (err) {
    console.error(`[linear] addLabels error: ${err.message}`);
    return false;
  }
}

/**
 * Search for a label by name within a team (or workspace).
 * @param {string} name — label name to find
 * @param {string} [teamId] — optional team filter
 * @returns {Promise<{id: string, name: string}|null>}
 */
export async function linearFindLabel(name, teamId) {
  try {
    const data = await linearGraphQL(`
      query {
        issueLabels {
          nodes {
            id
            name
            team { id }
          }
        }
      }
    `);
    const labels = data?.issueLabels?.nodes || [];
    const match = labels.find((l) => {
      const nameMatch = l.name.toLowerCase() === name.toLowerCase();
      if (!teamId) return nameMatch;
      return nameMatch && (!l.team || l.team.id === teamId);
    });
    return match || null;
  } catch (err) {
    console.error(`[linear] findLabel error: ${err.message}`);
    return null;
  }
}

/**
 * Create a label in Linear.
 * @param {string} name
 * @param {string} teamId
 * @param {string} [color] — hex color, default '#e74c3c'
 * @returns {Promise<{id: string, name: string}|null>}
 */
export async function linearCreateLabel(name, teamId, color = '#e74c3c') {
  try {
    const data = await linearGraphQL(
      `mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }`,
      { input: { name, teamId, color } },
    );
    const result = data?.issueLabelCreate;
    if (!result?.success) return null;
    console.log(`[linear] Created label "${name}" (${result.issueLabel.id})`);
    return result.issueLabel;
  } catch (err) {
    console.error(`[linear] createLabel error: ${err.message}`);
    return null;
  }
}

// ─── State management ─────────────────────────────────────────────────────────

/**
 * Update workflow state of a Linear issue.
 * @param {string} issueId — Linear issue UUID
 * @param {string} stateId — target workflow state UUID
 * @returns {Promise<boolean>}
 */
export async function linearUpdateIssueState(issueId, stateId) {
  try {
    const data = await linearGraphQL(
      `mutation($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
          issue {
            id
            state { id name }
          }
        }
      }`,
      { issueId, stateId },
    );
    const result = data?.issueUpdate;
    if (!result?.success) {
      console.error('[linear] issueUpdate: success=false');
      return false;
    }
    console.log(`[linear] Updated issue ${issueId} state to ${result.issue?.state?.name}`);
    return true;
  } catch (err) {
    console.error(`[linear] updateIssueState error: ${err.message}`);
    return false;
  }
}

// ─── Teams & workflow states ──────────────────────────────────────────────────

/**
 * Get all teams with their workflow states.
 * Returns a map: { [teamKey]: { id, key, name, states: { [stateName]: stateId } } }
 * @returns {Promise<object>}
 */
export async function linearGetTeams() {
  try {
    const data = await linearGraphQL(`
      query {
        teams {
          nodes {
            id
            key
            name
            states {
              nodes {
                id
                name
                type
              }
            }
          }
        }
      }
    `);

    const teams = {};
    for (const team of data?.teams?.nodes || []) {
      const states = {};
      for (const state of team.states?.nodes || []) {
        states[state.name] = { id: state.id, type: state.type };
      }
      teams[team.key] = {
        id: team.id,
        key: team.key,
        name: team.name,
        states,
      };
    }
    return teams;
  } catch (err) {
    console.error(`[linear] getTeams error: ${err.message}`);
    return {};
  }
}

/**
 * Get workflow states for a specific team.
 * @param {string} teamId — Linear team UUID
 * @returns {Promise<Array<{id: string, name: string, type: string}>>}
 */
export async function linearGetTeamStates(teamId) {
  try {
    const data = await linearGraphQL(
      `query($teamId: String!) {
        team(id: $teamId) {
          states {
            nodes {
              id
              name
              type
            }
          }
        }
      }`,
      { teamId },
    );
    return data?.team?.states?.nodes || [];
  } catch (err) {
    console.error(`[linear] getTeamStates error: ${err.message}`);
    return [];
  }
}

// ─── WIP count ────────────────────────────────────────────────────────────────

/**
 * Count issues in "In Progress" (started) state for a given assignee within a team.
 * Uses Linear's issue filtering to find issues assigned to the user that are in a
 * "started" workflow state type.
 * @param {string} assigneeId — Linear user UUID
 * @param {string} teamId — Linear team UUID
 * @returns {Promise<number>}
 */
export async function linearCountInProgressForAssignee(assigneeId, teamId) {
  try {
    const data = await linearGraphQL(
      `query($assigneeId: ID, $teamId: ID) {
        issues(
          filter: {
            assignee: { id: { eq: $assigneeId } }
            team: { id: { eq: $teamId } }
            state: { type: { eq: "started" } }
          }
        ) {
          totalCount
        }
      }`,
      { assigneeId, teamId },
    );
    return data?.issues?.totalCount ?? 0;
  } catch (err) {
    console.error(`[linear] countInProgressForAssignee error: ${err.message}`);
    return 0;
  }
}
