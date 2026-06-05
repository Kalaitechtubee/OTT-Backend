/**
 * Title helper for stripping language, quality, and release suffixes
 * to maximize TMDB/OMDb metadata matching rates.
 */

// Suffixes that typically appear in provider titles (parentheses, brackets, colons, hyphens, or end of string)
const SUFFIX_WORDS = [
  'telugu', 'tamil', 'hindi', 'kannada', 'malayalam', 'bengali', 'marathi', 'gujarati', 'punjabi', 'odia', 'urdu',
  'dubbed', 'dub', 'sub', 'eng', 'english', 'extended', 'remastered', 'unrated', "director['\"]?s\\s*cut",
  '4k', 'hdr', 'bluray', 'web-dl', 'webdl', 'hdrip', 'dvdrip', 'rip', 'camrip', 'cam', 'hc', 'hevc', 'x264', 'x265',
  'reloaded version', 'reloaded', 'original', 'org', 'aud', 'clean', 'hq', 'hq clean', 'original aud', 'hq clean aud',
  'extended cut', 'cut', 'supercut', '3d', 'hdtv', 'web', 'dl', 'new', 'latest', 'multiplex', 'proper',
  'teaser', 'trailer', 'clip', 'promo', 'sneak peek', 'sneakpeek'
];

// Regex to remove anything inside parentheses or brackets: (Hindi), [Tamil], etc.
const PAREN_BRACKET_RE = /\s*[\(\[][^\]\)]*[\)\]]/gi;

// Regex to remove trailing suffix words at the end of the title or preceded by a dash/colon
const SUFFIX_RE = new RegExp(
  `(?:\\s+|-|:|\\/)\\s*(?:${SUFFIX_WORDS.join('|')})(?:\\s+|$|\\b)`,
  'gi'
);

function stripLangSuffix(title) {
  if (!title) return '';
  let cleaned = title;
  
  // 1. Remove parenthesized or bracketed info first: "Jawan (Tamil)" -> "Jawan"
  cleaned = cleaned.replace(PAREN_BRACKET_RE, ' ');
  
  // 2. Remove trailing words / colons / hyphens
  let prev = '';
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned.replace(SUFFIX_RE, ' ');
  }
  
  // 3. Remove multiple spaces and trim
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  // 4. Remove trailing punctuation commonly left over (dashes, colons, slashes)
  cleaned = cleaned.replace(/[:\-\/\s]+$/, '').trim();
  
  return cleaned || title;
}

function cleanTitle(title) {
  if (!title) return '';
  return title.toLowerCase().replace(/[^\w\s-]/g, '').trim();
}

/**
 * Advanced normalization for fuzzy title comparison.
 */
function normalizeTitle(title) {
  if (!title) return '';
  
  // 1. Strip language/quality suffixes first
  let cleaned = stripLangSuffix(title);
  
  // 2. Convert to lowercase
  cleaned = cleaned.toLowerCase();
  
  // 3. Normalize common abbreviations/connectors
  cleaned = cleaned.replace(/&/g, 'and');
  
  // 4. Remove all non-alphanumeric characters, keeping only spaces and word chars
  cleaned = cleaned.replace(/[^\w\s]/g, '');
  
  // 5. Clean up extra spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  return cleaned;
}

/**
 * Computes Levenshtein distance between two strings.
 */
function getLevenshteinDistance(s1, s2) {
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else {
        if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          }
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
    }
    if (i > 0) {
      costs[s2.length] = lastValue;
    }
  }
  return costs[s2.length];
}

/**
 * Returns similarity ratio (0 to 1) based on Levenshtein distance.
 */
function getLevenshteinSimilarity(s1, s2) {
  const longer = s1.length >= s2.length ? s1 : s2;
  const shorter = s1.length < s2.length ? s1 : s2;
  const longerLength = longer.length;
  if (longerLength === 0) {
    return 1.0;
  }
  return (longerLength - getLevenshteinDistance(longer, shorter)) / parseFloat(longerLength);
}

/**
 * Combined similarity score (0 to 100) based on Levenshtein similarity (60%) and Token overlap (40%).
 */
function getFuzzyScore(titleA, titleB) {
  const normA = normalizeTitle(titleA);
  const normB = normalizeTitle(titleB);

  if (normA === normB) return 100;
  if (!normA || !normB) return 0;

  // 1. Levenshtein similarity (0 to 1)
  const levSim = getLevenshteinSimilarity(normA, normB);

  // 2. Token overlap similarity
  const wordsA = normA.split(/\s+/).filter(Boolean);
  const wordsB = normB.split(/\s+/).filter(Boolean);
  const intersection = wordsA.filter(w => wordsB.includes(w));
  const tokenSim = wordsA.length && wordsB.length
    ? intersection.length / Math.max(wordsA.length, wordsB.length)
    : 0;

  return (levSim * 60) + (tokenSim * 40);
}

function extractAudioLanguages(title) {
  if (!title) return [];
  const lower = title.toLowerCase();
  const languages = [];
  
  if (lower.includes('tamil')) languages.push('Tamil');
  if (lower.includes('telugu')) languages.push('Telugu');
  if (lower.includes('hindi')) languages.push('Hindi');
  if (lower.includes('malayalam')) languages.push('Malayalam');
  if (lower.includes('kannada')) languages.push('Kannada');
  if (lower.includes('english') || lower.includes('eng')) {
    if (!languages.includes('English')) languages.push('English');
  }
  if (lower.includes('bengali')) languages.push('Bengali');
  if (lower.includes('marathi')) languages.push('Marathi');
  
  if (lower.includes('dual audio') || lower.includes('dual-audio')) {
    languages.push('Dual Audio');
  }
  if (lower.includes('multi audio') || lower.includes('multi-audio') || lower.includes('multi audio')) {
    if (!languages.includes('Multi Audio')) {
      languages.push('Multi Audio');
    }
  }
  
  return languages;
}

module.exports = {
  stripLangSuffix,
  cleanTitle,
  normalizeTitle,
  getFuzzyScore,
  extractAudioLanguages
};
