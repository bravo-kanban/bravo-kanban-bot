/**
 * github-client.js — GitHub API helpers (REST + GraphQL)
 *
 * All functions accept an authenticated Octokit instance as first argument.
 */

// ─── Comments ─────────────────────────────────────────────────────────────────

/**
 * Find a bot comment on an issue by marker string in its body.
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @param {string} marker — HTML comment marker, e.g. "<!-- guardian-check -->"
 * @returns {Promise<{id: number, body: string}|null>}
 */
export async function findBotComment(octokit, owner, repo, issueNumber, marker) {
  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });

    for (const comment of comments) {
      if (comment.body && comment.body.includes(marker)) {
        return { id: comment.id, body: comment.body };
      }
    }
    return null;
  } catch (err) {
    console.error(`[github] findBotComment error: ${err.message}`);
    return null;
  }
}

/**
 * Upsert (create or update) a bot comment with a given marker.
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @param {string} marker
 * @param {string} body — full comment body
 * @returns {Promise<void>}
 */
export async function upsertBotComment(octokit, owner, repo, issueNumber, marker, body) {
  try {
    const existing = await findBotComment(octokit, owner, repo, issueNumber, marker);
    if (existing) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
      console.log(`[github] Updated comment ${existing.id} on ${owner}/${repo}#${issueNumber}`);
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      console.log(`[github] Created new comment on ${owner}/${repo}#${issueNumber}`);
    }
  } catch (err) {
    console.error(`[github] upsertBotComment error: ${err.message}`);
  }
}

/**
 * Post a regular comment (no upsert). Returns the created comment data.
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @param {string} body
 * @returns {Promise<{id: number}|null>}
 */
export async function postComment(octokit, owner, repo, issueNumber, body) {
  try {
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    console.log(`[github] Posted comment ${data.id} on ${owner}/${repo}#${issueNumber}`);
    return data;
  } catch (err) {
    console.error(`[github] postComment error: ${err.message}`);
    return null;
  }
}

/**
 * Update an existing comment by ID.
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} commentId
 * @param {string} body
 * @returns {Promise<void>}
 */
export async function updateComment(octokit, owner, repo, commentId, body) {
  try {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body,
    });
    console.log(`[github] Updated comment ${commentId} on ${owner}/${repo}`);
  } catch (err) {
    console.error(`[github] updateComment error: ${err.message}`);
  }
}

// ─── Issue / Assignees ────────────────────────────────────────────────────────

/**
 * Get issue details.
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @returns {Promise<object|null>}
 */
export async function getIssue(octokit, owner, repo, issueNumber) {
  try {
    const { data } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });
    return data;
  } catch (err) {
    console.error(`[github] getIssue error: ${err.message}`);
    return null;
  }
}

/**
 * Get all comments on an issue.
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @returns {Promise<Array>}
 */
export async function getIssueComments(octokit, owner, repo, issueNumber) {
  try {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    return data;
  } catch (err) {
    console.error(`[github] getIssueComments error: ${err.message}`);
    return [];
  }
}

// ─── WIP Count ────────────────────────────────────────────────────────────────

/**
 * Count issues "In Progress" for a given assignee login across multiple repos.
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} org
 * @param {string[]} repos
 * @param {string} assigneeLogin
 * @returns {Promise<number>}
 */
export async function countInProgressForAssignee(octokit, org, repos, assigneeLogin) {
  let count = 0;
  for (const repo of repos) {
    try {
      const { data: issues } = await octokit.rest.issues.listForRepo({
        owner: org,
        repo,
        assignee: assigneeLogin,
        state: 'open',
        per_page: 100,
      });
      // Check labels for "In Progress"
      for (const issue of issues) {
        const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name || ''));
        if (labels.some((l) => l.toLowerCase().includes('in progress'))) {
          count++;
        }
      }
    } catch (err) {
      // Repo may not exist or no access — skip silently
      console.warn(`[github] countInProgress: skipping ${org}/${repo}: ${err.message}`);
    }
  }
  return count;
}

// ─── Project V2 / GraphQL ─────────────────────────────────────────────────────

/**
 * Get the Project V2 item ID for an issue, and current Status field option.
 * @param {import('@octokit/graphql').graphql} graphqlFn
 * @param {string} projectId
 * @param {string} org
 * @param {string} repo
 * @param {number} issueNumber
 * @returns {Promise<{itemId: string|null, currentStatus: string|null, optionId: string|null}>}
 */
export async function getProjectItemForIssue(graphqlFn, projectId, org, repo, issueNumber) {
  try {
    const query = `
      query($org: String!, $repo: String!, $issueNumber: Int!) {
        repository(owner: $org, name: $repo) {
          issue(number: $issueNumber) {
            projectItems(first: 10) {
              nodes {
                id
                project { id }
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      optionId
                      field {
                        ... on ProjectV2SingleSelectField {
                          id
                          name
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const result = await graphqlFn(query, { org, repo, issueNumber });
    const items = result?.repository?.issue?.projectItems?.nodes || [];

    // Find the item that belongs to our project
    const item = items.find((i) => i.project?.id === projectId) || items[0];
    if (!item) return { itemId: null, currentStatus: null, optionId: null };

    const fieldValues = item.fieldValues?.nodes || [];
    const statusField = fieldValues.find(
      (fv) => fv?.field?.name?.toLowerCase().includes('status'),
    );

    return {
      itemId: item.id,
      currentStatus: statusField?.name || null,
      optionId: statusField?.optionId || null,
    };
  } catch (err) {
    console.error(`[github] getProjectItemForIssue error: ${err.message}`);
    return { itemId: null, currentStatus: null, optionId: null };
  }
}

/**
 * Get available Status field options from a project.
 * @param {import('@octokit/graphql').graphql} graphqlFn
 * @param {string} projectId
 * @param {string} statusFieldId
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getStatusFieldOptions(graphqlFn, projectId, statusFieldId) {
  try {
    const query = `
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            fields(first: 20) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    `;

    const result = await graphqlFn(query, { projectId });
    const fields = result?.node?.fields?.nodes || [];
    const statusField = fields.find((f) => f?.id === statusFieldId || f?.name?.toLowerCase().includes('status'));
    return statusField?.options || [];
  } catch (err) {
    console.error(`[github] getStatusFieldOptions error: ${err.message}`);
    return [];
  }
}

/**
 * Update project item Status field via GraphQL mutation.
 * @param {import('@octokit/graphql').graphql} graphqlFn
 * @param {string} projectId
 * @param {string} itemId
 * @param {string} fieldId
 * @param {string} optionId
 * @returns {Promise<boolean>}
 */
export async function updateProjectItemStatus(graphqlFn, projectId, itemId, fieldId, optionId) {
  try {
    const mutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item {
            id
          }
        }
      }
    `;

    await graphqlFn(mutation, { projectId, itemId, fieldId, optionId });
    console.log(`[github] Updated project item ${itemId} status to option ${optionId}`);
    return true;
  } catch (err) {
    console.error(`[github] updateProjectItemStatus error: ${err.message}`);
    return false;
  }
}

/**
 * Fetch PROJECT.json from a repo if it exists.
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<object|null>}
 */
export async function fetchProjectConfig(octokit, owner, repo) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: 'PROJECT.json',
    });
    if (data.type === 'file' && data.content) {
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      return JSON.parse(content);
    }
    return null;
  } catch (err) {
    // File may not exist
    console.warn(`[github] fetchProjectConfig: ${err.message}`);
    return null;
  }
}

/**
 * Add a label to an issue (best-effort).
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @param {string[]} labels
 */
export async function addLabels(octokit, owner, repo, issueNumber, labels) {
  try {
    await octokit.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
  } catch (err) {
    console.warn(`[github] addLabels: ${err.message}`);
  }
}
