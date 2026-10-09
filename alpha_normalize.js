"use strict";

/**
 * alpha_normalize.js
 * 用途：在Alpha审核前消除 Unicode、不可见字符和常见排版规避，避免
 *       禁止规则被零宽字符、异体字或 CJK 字符间空白绕过。
 * 作者：ji（Jim） · 2026-09-16
 */

const FORMAT_CHARACTERS = /\p{Cf}/gu;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const WHITESPACE = /\s+/gu;
const CJK_CHARACTER = "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF";
const CJK_INTERNAL_SPACE = new RegExp(
  `([${CJK_CHARACTER}])\\s+(?=[${CJK_CHARACTER}])`,
  "gu",
);

// NFKC does not convert traditional Chinese script to simplified Chinese.
// Keep this map deliberately small and tied to policy vocabulary.
const KNOWN_VARIANTS = Object.freeze({
  無: "无",
  內: "内",
  補: "补",
});
const KNOWN_VARIANT_CHARACTERS = /[無內補]/gu;

function mapKnownVariants(text) {
  return text.replace(
    KNOWN_VARIANT_CHARACTERS,
    (character) => KNOWN_VARIANTS[character],
  );
}

/**
 * Return a new, policy-safe representation of text without mutating input.
 * NFKC handles compatibility forms and full/half-width variants. Format
 * characters cover zero-width spaces/joiners, soft hyphen, and BOM.
 *
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  if (typeof text !== "string") {
    throw new TypeError("normalize(text) requires a string");
  }

  const nfkc = text.normalize("NFKC");
  const withoutInvisible = nfkc
    .replace(FORMAT_CHARACTERS, "")
    .replace(CONTROL_CHARACTERS, "");
  const withSingleSpaces = withoutInvisible.replace(WHITESPACE, " ").trim();
  const withoutCjkEvasionSpaces = withSingleSpaces.replace(
    CJK_INTERNAL_SPACE,
    "$1",
  );

  return mapKnownVariants(withoutCjkEvasionSpaces);
}

function escapeRegExp(text) {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function compileStringPattern(pattern) {
  const caseInsensitivePrefix = /^\(\?i\)/u;
  const source = caseInsensitivePrefix.test(pattern)
    ? pattern.slice(4)
    : pattern;
  const flags = caseInsensitivePrefix.test(pattern) ? "iu" : "u";

  try {
    return new RegExp(source, flags);
  } catch (_error) {
    return new RegExp(escapeRegExp(normalize(pattern)), "u");
  }
}

function matchesPattern(text, pattern) {
  if (pattern instanceof RegExp) {
    // Clone the expression so global/sticky patterns cannot mutate caller state.
    return new RegExp(pattern.source, pattern.flags).test(text);
  }

  if (typeof pattern !== "string") return false;

  const normalizedPattern = normalize(pattern);
  if (normalizedPattern && text.includes(normalizedPattern)) return true;

  return compileStringPattern(pattern).test(text);
}

/**
 * Return true when normalized text matches at least one forbidden pattern.
 * String patterns support regex syntax and literal normalized substring checks;
 * RegExp inputs are cloned before use so this function remains pure.
 *
 * @param {string} normalizedText
 * @param {Array<string|RegExp>} patterns
 * @returns {boolean}
 */
function matchesAny(normalizedText, patterns) {
  if (typeof normalizedText !== "string" || !Array.isArray(patterns)) {
    return false;
  }

  const text = normalize(normalizedText);
  return patterns.some((pattern) => matchesPattern(text, pattern));
}

module.exports = { matchesAny, normalize };
