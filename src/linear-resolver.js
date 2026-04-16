/**
 * linear-resolver.js — Resolve Guardian profile from Linear webhook data
 *
 * Maps Linear team + project → Guardian profile key.
 */

import { LINEAR_PROJECT_MAP, LINEAR_TEAM_PROFILE_MAP, LINEAR_TEAMS } from './config.js';

/**
 * Resolve which Guardian profile key to use for a Linear issue.
 *
 * Priority:
 *   1. If issue has a project whose name is in LINEAR_PROJECT_MAP → use that
 *   2. If issue's team key maps via LINEAR_TEAM_PROFILE_MAP → use that
 *   3. Fall back to null (default profile)
 *
 * @param {object} issueData — Linear issue data from webhook or API
 * @param {object} [issueData.project] — { id, name } or null
 * @param {object} [issueData.team] — { id, key, name }
 * @returns {string|null} — Guardian profile key (e.g. 'Браво', 'СУР', 'ФД', 'Head')
 */
export function resolveLinearProject(issueData) {
  // 1. Check if issue has a project that maps to a Guardian profile
  const projectName = issueData?.project?.name;
  if (projectName && LINEAR_PROJECT_MAP[projectName]) {
    return LINEAR_PROJECT_MAP[projectName];
  }

  // 2. Fall back to team-based mapping
  const teamKey = issueData?.team?.key;
  if (teamKey && LINEAR_TEAM_PROFILE_MAP[teamKey]) {
    return LINEAR_TEAM_PROFILE_MAP[teamKey];
  }

  // 3. No mapping found
  return null;
}

/**
 * Get the Backlog state ID for a team from the LINEAR_TEAMS cache.
 *
 * @param {string} teamId — Linear team UUID
 * @returns {string|null} — Backlog state UUID, or null if not found
 */
export function resolveBacklogStateId(teamId) {
  // Search LINEAR_TEAMS cache by team ID
  for (const teamData of Object.values(LINEAR_TEAMS)) {
    if (teamData.id === teamId && teamData.states) {
      // Look for a state named "Backlog" or with type "backlog"
      for (const [stateName, stateInfo] of Object.entries(teamData.states)) {
        if (
          stateName.toLowerCase() === 'backlog' ||
          stateInfo.type === 'backlog'
        ) {
          return stateInfo.id;
        }
      }
    }
  }
  return null;
}
