/**
 * Strip HTML tags and encode common XSS vectors from a string.
 * @param {string} text
 * @returns {string}
 */
function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')           // strip HTML tags
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .trim();
}

module.exports = { sanitizeText };
