/** Conservative keyword screen for content that requires explicit user review. */
const SENSITIVE = [
  /\b(health|medical|medication|diagnos\w*|therap\w*|depress\w*|anxiety|disorder|illness|disabilit\w*|pregnan\w*|surgery)\b/i,
  /\b(religio\w*|faith|atheis\w*|muslim|christian|jewish|hindu|buddhis\w*)\b/i,
  /\b(politic\w*|vote[sd]?|voting|democrat|republican|party affiliation)\b/i,
  /\b(sexual\w*|gay|lesbian|bisexual|transgender|orientation)\b/i,
  /\b(ethnic\w*|race|racial|immigration|citizenship|visa status)\b/i,
  /\b(salary|income|debt|bankrupt\w*|credit score|net worth)\b/i,
  /\b(criminal|arrest\w*|convict\w*|lawsuit)\b/i,
  /\b(biometric\w*|genetic\w*|dna)\b/i
];

export const isSensitive = (text: string): boolean => SENSITIVE.some(pattern => pattern.test(text));
