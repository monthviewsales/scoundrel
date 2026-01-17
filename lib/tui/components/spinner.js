'use strict';

const React = require('react');

/**
 * Build a simple spinner component.
 *
 * @param {object} ink
 * @returns {{ Spinner: Function }}
 */
function createSpinnerComponent(ink) {
  const { Text } = ink;
  const h = React.createElement;
  const framesDefault = ['-', '\\', '|', '/'];

  function Spinner({ label, intervalMs = 120, frames = framesDefault }) {
    const [idx, setIdx] = React.useState(0);

    React.useEffect(() => {
      const timer = setInterval(() => {
        setIdx((prev) => (prev + 1) % frames.length);
      }, intervalMs);
      return () => clearInterval(timer);
    }, [frames, intervalMs]);

    const frame = frames[idx] || framesDefault[0];
    return h(Text, null, label ? `${frame} ${label}` : frame);
  }

  return { Spinner };
}

module.exports = {
  createSpinnerComponent,
};
