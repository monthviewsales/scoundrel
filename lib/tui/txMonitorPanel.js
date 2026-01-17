'use strict';

const React = require('react');
const { createTxSummaryCardComponents } = require('./txSummaryCard');

/**
 * Factory: inject Ink bindings.
 *
 * @param {object} ink
 * @returns {{ TxMonitorPanel: Function }}
 */
function createTxMonitorPanelComponents(ink) {
  const { Box, Text } = ink;
  const h = React.createElement;
  const { TxSummaryCard } = createTxSummaryCardComponents(ink);

  /**
   * Shared transaction monitor panel.
   *
   * @param {object} props
   * @param {string} [props.title]
   * @param {string} [props.subtitle]
   * @param {string} [props.status]
   * @param {object} [props.summary]
   * @param {string} [props.error]
   * @param {string} [props.hint]
   * @param {React.ReactNode} [props.children]
   * @returns {React.ReactElement}
   */
  function TxMonitorPanel({
    title,
    subtitle,
    status,
    summary,
    error,
    hint,
    children,
  }) {
    const bodyChildren = [];
    const hasSummary = summary && typeof summary === 'object';
    const extraChildren = React.Children.toArray(children);

    if (error) {
      bodyChildren.push(h(Text, { color: 'red' }, error));
    } else if (hasSummary) {
      bodyChildren.push(
        h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          h(TxSummaryCard, { summary }),
          hint ? h(Text, { dimColor: true }, hint) : null
        )
      );
    } else {
      if (status) {
        bodyChildren.push(h(Text, { color: 'cyan' }, status));
      }
      if (extraChildren.length) {
        bodyChildren.push(...extraChildren);
      }
      if (hint) {
        bodyChildren.push(h(Text, { dimColor: true }, hint));
      }
    }

    return h(
      Box,
      { flexDirection: 'column' },
      title ? h(Text, { bold: true }, title) : null,
      subtitle ? h(Text, { dimColor: true }, subtitle) : null,
      ...bodyChildren
    );
  }

  return { TxMonitorPanel };
}

module.exports = {
  createTxMonitorPanelComponents,
};
