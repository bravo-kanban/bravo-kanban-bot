/**
 * platform.js — Platform adapter: abstracts GitHub vs Linear API calls.
 *
 * Guardian and handlers use this interface instead of direct API calls.
 * Each adapter exposes the same set of async methods:
 *   - postComment(body) → { id } | null
 *   - updateComment(commentId, body) → void
 *   - getComments() → Array
 *   - moveToBacklog() → boolean
 *   - countInProgress(assigneeIdentifier) → number
 */

import { GUARDIAN_REPOS, GITHUB_ORG } from './config.js';

// ─── GitHub adapter ───────────────────────────────────────────────────────────

/**
 * Create a platform adapter backed by GitHub API.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {Function} graphqlFn — authenticated graphql function
 * @param {object} ctx
 * @param {string} ctx.owner
 * @param {string} ctx.repo
 * @param {number} ctx.issueNumber
 * @param {object} [ctx.resolved] — resolved project context
 * @returns {object} platform adapter
 */
export function createGitHubAdapter(octokit, graphqlFn, { owner, repo, issueNumber, resolved }) {
  return {
    platform: 'github',
    issueKey: `${owner}/${repo}#${issueNumber}`,

    postComment: async (body) => {
      const { postComment } = await import('./github-client.js');
      return postComment(octokit, owner, repo, issueNumber, body);
    },

    updateComment: async (commentId, body) => {
      const { updateComment } = await import('./github-client.js');
      return updateComment(octokit, owner, repo, commentId, body);
    },

    getComments: async () => {
      const { getIssueComments } = await import('./github-client.js');
      return getIssueComments(octokit, owner, repo, issueNumber);
    },

    moveToBacklog: async () => {
      if (!resolved?.projectId || !resolved?.itemId || !resolved?.statusFieldId) return false;
      const { getStatusFieldOptions, updateProjectItemStatus } = await import('./github-client.js');
      try {
        // Use pre-resolved backlogOptionId if available, otherwise fetch
        let backlogOptionId = resolved.backlogOptionId;
        if (!backlogOptionId) {
          const options = await getStatusFieldOptions(graphqlFn, resolved.projectId, resolved.statusFieldId);
          const backlogOption = options.find((o) => o.name.toLowerCase().includes('backlog'));
          if (!backlogOption) return false;
          backlogOptionId = backlogOption.id;
        }
        return await updateProjectItemStatus(graphqlFn, resolved.projectId, resolved.itemId, resolved.statusFieldId, backlogOptionId);
      } catch (err) {
        console.warn(`[platform:github] moveToBacklog error: ${err.message}`);
        return false;
      }
    },

    countInProgress: async (assigneeLogin) => {
      const { countInProgressForAssignee } = await import('./github-client.js');
      return countInProgressForAssignee(octokit, GITHUB_ORG, GUARDIAN_REPOS, assigneeLogin);
    },
  };
}

// ─── Linear adapter ───────────────────────────────────────────────────────────

/**
 * Create a platform adapter backed by Linear API.
 *
 * @param {object} ctx
 * @param {string} ctx.issueId — Linear issue UUID
 * @param {string} ctx.teamId — Linear team UUID
 * @param {string} [ctx.backlogStateId] — Backlog workflow state UUID
 * @returns {object} platform adapter
 */
export function createLinearAdapter({ issueId, teamId, backlogStateId }) {
  return {
    platform: 'linear',
    issueKey: `linear#${issueId}`,

    postComment: async (body) => {
      const { linearPostComment } = await import('./linear-client.js');
      return linearPostComment(issueId, body);
    },

    updateComment: async (commentId, body) => {
      const { linearUpdateComment } = await import('./linear-client.js');
      return linearUpdateComment(commentId, body);
    },

    getComments: async () => {
      const { linearGetIssueComments } = await import('./linear-client.js');
      return linearGetIssueComments(issueId);
    },

    moveToBacklog: async () => {
      if (!backlogStateId) return false;
      const { linearUpdateIssueState } = await import('./linear-client.js');
      return linearUpdateIssueState(issueId, backlogStateId);
    },

    countInProgress: async (assigneeId) => {
      const { linearCountInProgressForAssignee } = await import('./linear-client.js');
      return linearCountInProgressForAssignee(assigneeId, teamId);
    },
  };
}
