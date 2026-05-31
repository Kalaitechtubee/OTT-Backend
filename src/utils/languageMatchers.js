/**
 * South Indian catalog languages supported in MovieZon menus.
 * Used by catalogFilter and client language pickers.
 */
const SOUTH_INDIAN_LANGUAGES = ['Tamil', 'Telugu', 'Malayalam', 'Kannada'];

/** Aliases Net27 uses in variant labels (e.g. "Tamil dub", "Telugu sub"). */
const LANG_ALIASES = {
  tamil: ['tamil', 'tam', 'தமிழ்'],
  telugu: ['telugu', 'telugu dub', 'tel', 'తెలుగు'],
  malayalam: ['malayalam', 'malayalam dub', 'mal', 'mollywood', 'മലയാളം'],
  kannada: ['kannada', 'kannada dub', 'kan', 'sandalwood', 'ಕನ್ನಡ'],
  hindi: ['hindi', 'hindi dub', 'hin', 'bollywood'],
  english: ['english', 'eng', 'original audio'],
};

function normalizeLanguageName(language) {
  if (!language || typeof language !== 'string') return '';
  const trimmed = language.trim();
  if (!trimmed || trimmed.toLowerCase() === 'all languages') return '';
  const lower = trimmed.toLowerCase();
  for (const canonical of SOUTH_INDIAN_LANGUAGES) {
    if (canonical.toLowerCase() === lower) return canonical;
  }
  return '';
}

function languageMatchesLabel(label, selectedLang) {
  if (!label || !selectedLang) return false;
  const lower = label.toLowerCase();
  const key = selectedLang.toLowerCase().trim();
  const aliases = LANG_ALIASES[key] || [key];
  return aliases.some((alias) => lower.includes(alias));
}

function isSupportedCatalogLanguage(language) {
  const norm = normalizeLanguageName(language);
  if (!norm) return false;
  return SOUTH_INDIAN_LANGUAGES.some((l) => l.toLowerCase() === norm.toLowerCase());
}

module.exports = {
  SOUTH_INDIAN_LANGUAGES,
  LANG_ALIASES,
  normalizeLanguageName,
  languageMatchesLabel,
  isSupportedCatalogLanguage,
};
