'use strict';

const OpenAI = require('openai');

/**
 * @typedef {Object} VectorStoreSearchResult
 * @property {string} file_id
 * @property {string} filename
 * @property {number} score
 * @property {Object} [attributes]
 * @property {Array<{ type: string, text?: string }>} [content]
 */

/**
 * Search a vector store using the OpenAI Vector Store Search API.
 *
 * @param {Object} params
 * @param {string} params.vectorStoreId
 * @param {string|Array<string>} params.query
 * @param {Object} [params.filters]
 * @param {number} [params.maxResults=8]
 * @param {boolean} [params.rewriteQuery=true]
 * @param {Object} [params.rankingOptions]
 * @returns {Promise<VectorStoreSearchResult[]>}
 */
async function searchVectorStore({
  vectorStoreId,
  query,
  filters,
  maxResults = 8,
  rewriteQuery = true,
  rankingOptions,
} = {}) {
  if (!vectorStoreId) {
    throw new Error('[vectorStoreSearch] vectorStoreId is required');
  }
  if (!query || (Array.isArray(query) && !query.length)) {
    throw new Error('[vectorStoreSearch] query is required');
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('[vectorStoreSearch] OPENAI_API_KEY is required');
  }

  const openai = new OpenAI({ apiKey });
  const response = await openai.vectorStores.search(vectorStoreId, {
    query,
    filters,
    max_num_results: Math.min(50, Math.max(1, Math.trunc(maxResults))),
    rewrite_query: Boolean(rewriteQuery),
    ranking_options: rankingOptions,
  });

  if (!response || !Array.isArray(response.data)) return [];
  return response.data;
}

module.exports = { searchVectorStore };
