'use strict';

const React = require('react');

/**
 * Build a progress bar component.
 *
 * @param {object} ink
 * @returns {{ ProgressBar: Function }}
 */
function createProgressBarComponent(ink) {
  const { Text } = ink;
  const h = React.createElement;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function ProgressBar({ value = 0, width = 20, label }) {
    const ratio = clamp(Number(value), 0, 1);
    const filled = Math.round(ratio * width);
    const empty = width - filled;
    const bar = `[${'#'.repeat(filled)}${'-'.repeat(empty)}]`;
    const pct = `${Math.round(ratio * 100)}%`;
    const suffix = label ? ` ${label}` : '';
    return h(Text, null, `${bar} ${pct}${suffix}`);
  }

  return { ProgressBar };
}

module.exports = {
  createProgressBarComponent,
};
