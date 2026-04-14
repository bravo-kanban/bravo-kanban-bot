/**
 * team-routing.js — Team routing matrix + disambiguation
 *
 * Scores issue title+body against keyword lists, applies disambiguation rules,
 * and optionally uses LLM for semantic matching.
 */

import { TEAM_ROUTING, DISAMBIGUATION_RULES } from './config.js';
import { suggestRoutingLLM } from './llm-client.js';

/**
 * Score each team member against title + body text.
 * @param {string} text — combined title + body
 * @returns {Array<{id: string, score: number}>} sorted descending by score
 */
function scoreMembers(text) {
  const lower = text.toLowerCase();
  const scores = Object.entries(TEAM_ROUTING).map(([id, member]) => {
    let score = 0;
    for (const kw of member.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        score += 1;
      }
    }
    return { id, score, name: member.name };
  });
  return scores.sort((a, b) => b.score - a.score);
}

/**
 * Apply disambiguation rules to override scoring.
 * @param {string} text
 * @param {Array<{id: string, score: number, name: string}>} ranked
 * @returns {{id: string, name: string}|null}
 */
function applyDisambiguation(text, ranked) {
  const lower = text.toLowerCase();

  for (const rule of DISAMBIGUATION_RULES) {
    const matches = rule.patterns.some((p) => lower.includes(p.toLowerCase()));
    if (matches) {
      return { id: rule.assignee, name: TEAM_ROUTING[rule.assignee]?.name || rule.assignee };
    }
  }

  // Return top-scored member with score > 0
  const top = ranked[0];
  if (top && top.score > 0) {
    return { id: top.id, name: top.name };
  }
  return null;
}

/**
 * Suggest routing for an issue.
 *
 * @param {string} title
 * @param {string} body
 * @returns {Promise<{id: string, name: string, reasoning: string}|null>}
 */
export async function suggestRouting(title, body) {
  const text = `${title} ${body || ''}`;
  const ranked = scoreMembers(text);
  const regexResult = applyDisambiguation(text, ranked);

  // Build candidate descriptions for LLM
  const topCandidates = ranked.slice(0, 5).map(
    (r) => `${r.id}: ${TEAM_ROUTING[r.id]?.keywords?.join(', ') || ''}`,
  );

  try {
    const llmResult = await suggestRoutingLLM(title, body, topCandidates);
    if (llmResult && llmResult.id && TEAM_ROUTING[llmResult.id]) {
      return {
        id: llmResult.id,
        name: TEAM_ROUTING[llmResult.id].name,
        reasoning: llmResult.reasoning,
      };
    }
  } catch {
    // fall through to regex result
  }

  if (regexResult) {
    const keywordsMatched = ranked
      .find((r) => r.id === regexResult.id)
      ?.score;
    return {
      id: regexResult.id,
      name: regexResult.name,
      reasoning: keywordsMatched
        ? `Совпадение по ключевым словам (${keywordsMatched} совпадений)`
        : 'Определено по правилам disambiguation',
    };
  }

  return null;
}

/**
 * Get full member info by ID.
 * @param {string} id
 * @returns {{name: string, keywords: string[], projects: string[]}|null}
 */
export function getMemberById(id) {
  return TEAM_ROUTING[id] || null;
}

/**
 * Get all team member IDs.
 * @returns {string[]}
 */
export function getAllMemberIds() {
  return Object.keys(TEAM_ROUTING);
}
