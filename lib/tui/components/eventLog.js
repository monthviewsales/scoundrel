'use strict';

const React = require('react');

/**
 * Build an event log component.
 *
 * @param {object} ink
 * @returns {{ EventLog: Function }}
 */
function createEventLogComponent(ink) {
  const { Box, Text } = ink;
  const h = React.createElement;

  function EventLog({ events, title = 'Events', maxItems = 6 }) {
    const list = Array.isArray(events) ? events.slice(0, maxItems) : [];
    if (!list.length) return null;

    return h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      h(Text, { dimColor: true }, title),
      list.map((event, idx) => {
        const text =
          event && typeof event === 'object'
            ? event.text || event.message || JSON.stringify(event)
            : String(event);
        return h(Text, { key: idx, dimColor: true }, `- ${text}`);
      })
    );
  }

  return { EventLog };
}

module.exports = {
  createEventLogComponent,
};
